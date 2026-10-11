import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IssuedKey, SpendReport, WorkspaceView } from '@lakka/contracts';
import { authenticate, createLogger, valkeyEvents } from '@lakka/core';
import { ensureMonthlyPartitions, insertUsage } from '@lakka/db';
import type { UsageInsert } from '@lakka/db';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The spend view (BG-11, F5, ADR 0055) from usage rows written directly, so every figure can be
 * checked exactly: by person, workspace, model and day, and who may see which part.
 */

let t: TestApp;
let root: SignedInUser;
let wsAdmin: SignedInUser;
let member: SignedInUser;
let colleague: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let memberKey: IssuedKey;
let keyPrincipalId: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const midnight = (offsetDays: number) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * DAY_MS,
  );
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayA = midnight(-2);
const dayB = midnight(-1);
/** Before the reported range. Its month may be the previous one, early in a month. */
const outsideRange = midnight(-10);

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${randomBytes(3).toString('hex')}`,
  });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

/** One request's usage: `attempts` rows sharing a request id, each costing `cost`. */
async function spent(
  ws: WorkspaceView,
  who: { principalId: string; actingUserId: string },
  model: string,
  cost: bigint,
  at: Date,
  extra: Partial<UsageInsert> = {},
  attempts = 1,
): Promise<void> {
  const requestId = randomUUID();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const row = await insertUsage(t.db, {
      requestId,
      attempt,
      outcome: attempt === attempts ? 'completed' : 'abandoned',
      surface: 'api',
      workspaceId: ws.id,
      principalId: who.principalId,
      actingUserId: who.actingUserId,
      model,
      provider: model.split(':')[0] ?? 'p',
      providerConfigId: null,
      inputTokens: 10,
      uncachedInputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      reasoningTokens: null,
      usageEstimated: false,
      inputMicroUsdPerMtok: 0,
      outputMicroUsdPerMtok: 0,
      cacheReadMicroUsdPerMtok: 0,
      cacheWriteMicroUsdPerMtok: 0,
      priceTierAboveInputTokens: null,
      costMicroUsd: cost,
      finishReason: 'stop',
      latencyMs: 10,
      ttftMs: 5,
      resolutionRule: 'explicit',
      ...extra,
    });
    await t.pool.query('update usage set created_at = $1 where id = $2', [
      new Date(at.getTime() + 12 * 60 * 60 * 1000),
      row.id,
    ]);
  }
}

const person = (u: SignedInUser) => ({ principalId: u.principal.id, actingUserId: u.principal.id });

async function report(
  who: SignedInUser,
  path: string,
  query = `?from=${iso(dayA)}&to=${iso(dayB)}`,
) {
  const res = await as(t, who).get(`${path}${query}`);
  return { status: res.statusCode, body: res.json() as SpendReport };
}

beforeAll(async () => {
  t = await createTestApp();
  // From the oldest row's month: this month and the next two, which covers every row here.
  await ensureMonthlyPartitions(t.pool, outsideRange);
  [root, wsAdmin, member, colleague] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Member'),
    signedInUser(t, 'Colleague'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  for (const [ws, user, role] of [
    [alpha, wsAdmin, 'admin'],
    [alpha, member, 'member'],
    [alpha, colleague, 'member'],
    [bravo, colleague, 'member'],
  ] as const) {
    await as(t, root).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, { role });
  }
  memberKey = (
    await as(t, member).post(`/api/workspaces/${alpha.id}/keys`, { name: 'CI' })
  ).json() as IssuedKey;
  keyPrincipalId = (
    await authenticate(
      {
        auth: t.auth,
        db: t.db,
        events: valkeyEvents(
          t.cache,
          createLogger({ level: 'silent', service: 'spend-test' }).logger,
        ),
      },
      { kind: 'api_key', secret: memberKey.secret },
    )
  ).id;

  // Alpha: the member directly and through their key, the colleague, over two days.
  await spent(alpha, person(member), 'anthropic:big', 3_000_000n, dayA);
  await spent(
    alpha,
    { principalId: keyPrincipalId, actingUserId: member.principal.id },
    'openai:small',
    500_000n,
    dayB,
  );
  // A request whose first attempt was abandoned: two rows, one request, both paid for.
  await spent(alpha, person(colleague), 'openai:small', 250_000n, dayB, {}, 2);
  // A request a cap downgraded.
  await spent(alpha, person(colleague), 'openai:small', 100_000n, dayB, {
    budgetFallbackFrom: 'anthropic:big',
  });
  // Bravo: the colleague, and a row outside the range.
  await spent(bravo, person(colleague), 'anthropic:big', 2_000_000n, dayA);
  await spent(bravo, person(colleague), 'anthropic:big', 9_000_000n, outsideRange);
});

afterAll(async () => {
  await t.close();
});

describe('the spend view (BG-11)', () => {
  it('BG-11: instance admins see the whole instance by workspace, person, model and day', async () => {
    const { status, body } = await report(root, '/api/spend');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      scope: 'instance',
      from: iso(dayA),
      to: iso(dayB),
      totalMicroUsd: '6100000',
      requests: 5,
      downgradedRequests: 1,
    });
    expect(body.byWorkspace.map((r) => [r.label, r.costMicroUsd, r.requests])).toEqual([
      ['Alpha', '4100000', 4],
      ['Bravo', '2000000', 1],
    ]);
    expect(body.byWorkspace.map((r) => r.cap)).toEqual([null, null]);
    // ADR 0093: a key's requests are a row of their own, naming its owner, so each dollar is
    // counted once.
    expect(body.byPerson.map((r) => [r.label, r.kind, r.costMicroUsd, r.requests])).toEqual([
      ['Member', 'user', '3000000', 1],
      ['Colleague', 'user', '2600000', 3],
      ['CI', 'key', '500000', 1],
    ]);
    expect(body.byPerson.find((r) => r.kind === 'key')?.owner).toEqual({
      id: member.principal.id,
      name: 'Member',
    });
    expect(body.byModel.map((r) => [r.key, r.label, r.costMicroUsd, r.requests])).toEqual([
      ['anthropic:big', 'Big', '5000000', 2],
      ['openai:small', 'Small', '1100000', 3],
    ]);
    expect(body.downgradedMicroUsd).toBe('100000');
    expect(body.byDay).toEqual([
      { date: iso(dayA), costMicroUsd: '5000000', requests: 2 },
      { date: iso(dayB), costMicroUsd: '1100000', requests: 3 },
    ]);
  });

  it("BG-11: each workspace's row carries its own cap, if it has one (ADR 0097)", async () => {
    const set = await as(t, root).put(`/api/workspaces/${bravo.id}/budgets/workspace`, {
      limitMicroUsd: '50000000',
      period: 'monthly',
    });
    expect(set.statusCode).toBe(200);
    try {
      const { body } = await report(root, '/api/spend');
      expect(body.byWorkspace.map((r) => [r.label, r.cap?.limitMicroUsd ?? null])).toEqual([
        ['Alpha', null],
        ['Bravo', '50000000'],
      ]);
      expect(body.byWorkspace[1]?.cap).toMatchObject({ period: 'monthly', scope: 'workspace' });
    } finally {
      await as(t, root).delete(`/api/workspaces/${bravo.id}/budgets/workspace`);
    }
  });

  it('BG-11: every day in the range is listed, including days with no spend', async () => {
    const { body } = await report(root, '/api/spend', `?from=${iso(midnight(-4))}&to=${iso(dayB)}`);
    expect(body.byDay.map((d) => [d.date, d.costMicroUsd])).toEqual([
      [iso(midnight(-4)), '0'],
      [iso(midnight(-3)), '0'],
      [iso(dayA), '5000000'],
      [iso(dayB), '1100000'],
    ]);
  });

  it("F5: a workspace admin sees their workspace, and nothing of another's", async () => {
    const { status, body } = await report(wsAdmin, `/api/workspaces/${alpha.id}/spend`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ scope: 'workspace', totalMicroUsd: '4100000', requests: 4 });
    expect(body.byWorkspace.map((r) => r.label)).toEqual(['Alpha']);
    expect((await report(wsAdmin, `/api/workspaces/${bravo.id}/spend`)).status).toBe(404);
    expect((await report(wsAdmin, '/api/spend')).status).toBe(403);
  });

  it('F5, invariant 2: a member sees only their own spend, their keys included', async () => {
    const { body } = await report(member, `/api/workspaces/${alpha.id}/spend`);
    expect(body).toMatchObject({ scope: 'own', totalMicroUsd: '3500000', requests: 2 });
    expect(body.byPerson.map((r) => r.label)).toEqual(['Member', 'CI']);
    const theirs = await report(colleague, `/api/workspaces/${alpha.id}/spend`);
    // Two attempts of 250,000 on one request, and a downgraded request of 100,000.
    expect(theirs.body).toMatchObject({
      totalMicroUsd: '600000',
      requests: 2,
      downgradedRequests: 1,
    });
  });

  it('ID-5: a key cannot read spend', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${alpha.id}/spend`,
      headers: { authorization: `Bearer ${memberKey.secret}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('defaults to the current month so far, and validates the range', async () => {
    const { body } = await report(root, '/api/spend', '');
    const now = new Date();
    expect(body.from).toBe(iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))));
    expect(body.to).toBe(iso(midnight(0)));
    for (const query of [
      `?from=${iso(dayB)}&to=${iso(dayA)}`,
      `?from=${iso(midnight(-400))}&to=${iso(dayB)}`,
      '?from=yesterday',
      '?from=2026-02-30',
      '?other=1',
    ]) {
      expect({ query, status: (await report(root, '/api/spend', query)).status }).toEqual({
        query,
        status: 400,
      });
    }
  });
});

describe('usage views (the tech spec, metrics from day one)', () => {
  it('BG-11: a workspace report adds surfaces, routes, the spread of latency and tokens, denials and tools', async () => {
    const at = new Date(dayB.getTime() + 6 * 60 * 60 * 1000);
    // A request a cap refused outright, and tool calls: two worked, one failed, one refused.
    await t.pool.query(
      `insert into reservations (id, request_id, workspace_id, principal_id, acting_user_id,
        amount_micro_usd, state, created_at, expires_at)
       values (gen_random_uuid(), gen_random_uuid(), $1, $2, $2, 1, 'denied', $3, $3)`,
      [alpha.id, member.principal.id, at],
    );
    for (const status of ['ok', 'ok', 'failed', 'rejected']) {
      await t.pool.query(
        `insert into tool_invocations (id, request_id, workspace_id, principal_id, acting_user_id,
          call_id, tool_name, arguments, status, duration_ms, created_at)
         values (gen_random_uuid(), gen_random_uuid(), $1, $2, $2, 'c', 'srv__echo', '{}', $3, 1, $4)`,
        [alpha.id, member.principal.id, status, at],
      );
    }
    const { body } = await report(wsAdmin, `/api/workspaces/${alpha.id}/spend`);
    expect(body.bySurface.map((r) => [r.key, r.requests])).toEqual([['api', 4]]);
    expect(body.byRoute.map((r) => [r.key, r.kind, r.requests])).toEqual([['chosen', 'chosen', 4]]);
    expect(body.latency).toEqual({ p50: 10, p95: 10 });
    expect(body.tokens).toEqual({ inputP50: 10, inputP95: 10, inputMax: 10, outputP95: 5 });
    expect(body.deniedRequests).toBe(1);
    expect(body.tools).toEqual([{ name: 'srv__echo', calls: 4, failed: 1, refused: 1 }]);
    expect(body).toMatchObject({ toolCallsRan: 3, toolCallsNotAllowed: 0, toolCallsDenied: 0 });

    // A member sees only their own.
    const own = await report(member, `/api/workspaces/${alpha.id}/spend`);
    expect(own.body.deniedRequests).toBe(1);
    const colleagues = await report(colleague, `/api/workspaces/${alpha.id}/spend`);
    expect(colleagues.body.deniedRequests).toBe(0);
    expect(colleagues.body.tools).toEqual([]);
  });
});

describe('the spend report the design draws (BG-11, ADR 0093)', () => {
  let gamma: WorkspaceView;
  const at = new Date(dayB.getTime() + 8 * 60 * 60 * 1000);

  beforeAll(async () => {
    gamma = await workspace('Gamma');
    for (const [user, role] of [
      [wsAdmin, 'admin'],
      [member, 'member'],
      [colleague, 'member'],
    ] as const) {
      await as(t, root).put(`/api/workspaces/${gamma.id}/members/${user.principal.id}`, { role });
    }
  });

  it('BG-11, RT-8: by route, each route with its model, then the default, choices and the pin', async () => {
    const { rows } = await t.pool.query<{ id: string }>(
      `insert into routes (id, workspace_id, name, model, threshold_down, threshold_up,
        created_by_principal_id)
       values (gen_random_uuid(), $1, 'code', 'anthropic:big', 0.35, 0.25, $2) returning id`,
      [gamma.id, wsAdmin.principal.id],
    );
    const routeId = rows[0]?.id ?? '';
    const routed = { resolutionRule: 'classified' as const, routeId, routeConfidence: 0.9 };
    await spent(gamma, person(member), 'anthropic:big', 400_000n, dayB, routed);
    await spent(gamma, person(member), 'anthropic:big', 300_000n, dayB, {
      resolutionRule: 'sticky',
      routeId,
    });
    await spent(gamma, person(member), 'openai:small', 100_000n, dayB, {
      resolutionRule: 'default',
      defaultReason: 'below_threshold',
    });
    // An override names the route that lost, and still counts as the person's choice.
    await spent(gamma, person(member), 'openai:small', 50_000n, dayB, {
      resolutionRule: 'explicit',
      routeId,
      wasOverridden: true,
      overriddenModel: 'anthropic:big',
    });
    await spent(gamma, person(member), 'openai:small', 20_000n, dayB, { resolutionRule: 'pinned' });
    const { body } = await report(wsAdmin, `/api/workspaces/${gamma.id}/spend`);
    expect(
      body.byRoute.map((r) => [r.key, r.kind, r.label, r.modelName, r.costMicroUsd, r.requests]),
    ).toEqual([
      [routeId, 'route', 'code', 'Big', '700000', 2],
      ['default', 'default', '', null, '100000', 1],
      ['chosen', 'chosen', '', null, '50000', 1],
      ['pinned', 'pinned', '', null, '20000', 1],
    ]);
  });

  it('BG-11, OB-1: refusals by why, from traces, and each person sees only their own', async () => {
    const request = async (who: SignedInUser, errorType: string | null) =>
      t.pool.query(
        `insert into spans (trace_id, span_id, workspace_id, request_id, name, kind, status,
          error_type, started_at, duration_ms, attributes)
         values ($1, $2, $3, gen_random_uuid(), 'request', 'server', $4, $5, $6, 1, $7)`,
        [
          randomBytes(16).toString('hex'),
          randomBytes(8).toString('hex'),
          gamma.id,
          errorType === null ? 'ok' : 'error',
          errorType,
          at,
          JSON.stringify({ 'lakka.acting_user_id': who.principal.id }),
        ],
      );
    await request(member, 'budget_exceeded');
    await request(member, 'budget_exceeded');
    await request(member, 'budget_unavailable');
    await request(colleague, 'rate_limited');
    // A provider failure is a failure, not a refusal; a request that worked is neither.
    await request(member, 'upstream_unavailable');
    await request(member, null);
    const admin = await report(wsAdmin, `/api/workspaces/${gamma.id}/spend`);
    expect(admin.body.refusals).toEqual([
      { code: 'budget_exceeded', requests: 2 },
      { code: 'budget_unavailable', requests: 1 },
      { code: 'rate_limited', requests: 1 },
    ]);
    const own = await report(colleague, `/api/workspaces/${gamma.id}/spend`);
    expect(own.body.refusals).toEqual([{ code: 'rate_limited', requests: 1 }]);
  });

  it('BG-11, TL-4, TL-5: tool calls that ran, were not allowed, and were denied by the person', async () => {
    const call = async (who: SignedInUser, status: string) => {
      const { rows } = await t.pool.query<{ id: string }>(
        `insert into tool_invocations (id, request_id, workspace_id, principal_id, acting_user_id,
          call_id, tool_name, arguments, status, duration_ms, created_at)
         values (gen_random_uuid(), gen_random_uuid(), $1, $2, $2, 'c', 'srv__echo', '{}', $3, 1, $4)
         returning id`,
        [gamma.id, who.principal.id, status, at],
      );
      return rows[0]?.id ?? '';
    };
    await call(member, 'ok');
    await call(member, 'timeout');
    await call(member, 'denied');
    const asked = await call(member, 'approval_required');
    await call(colleague, 'ok');
    await t.pool.query(
      `insert into tool_approvals (id, workspace_id, conversation_id, request_id, principal_id,
        tool_invocation_id, workspace_tool_id, tool_name, call_id, status, decided_at)
       values (gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid(), $2, $3, gen_random_uuid(),
        'srv__echo', 'c',
        'denied', $4)`,
      [gamma.id, member.principal.id, asked, at],
    );
    const admin = await report(wsAdmin, `/api/workspaces/${gamma.id}/spend`);
    expect(admin.body).toMatchObject({
      toolCallsRan: 3,
      toolCallsNotAllowed: 1,
      toolCallsDenied: 1,
    });
    const own = await report(colleague, `/api/workspaces/${gamma.id}/spend`);
    expect(own.body).toMatchObject({ toolCallsRan: 1, toolCallsNotAllowed: 0, toolCallsDenied: 0 });
  });

  it('BG-11: speed and size by model, median and 95th percentile, over completed replies', async () => {
    const { body } = await report(wsAdmin, `/api/workspaces/${gamma.id}/spend`);
    expect(body.speedByModel.map((m) => [m.model, m.name, m.requests])).toEqual([
      ['openai:small', 'Small', 3],
      ['anthropic:big', 'Big', 2],
    ]);
    expect(body.speedByModel[0]).toMatchObject({
      latency: { p50: 10, p95: 10 },
      timeToFirstToken: { p50: 5, p95: 5 },
      inputTokens: { p50: 10, p95: 10 },
      outputTokens: { p50: 5, p95: 5 },
    });
  });
});
