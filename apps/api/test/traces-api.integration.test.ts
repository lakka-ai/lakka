import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  IssuedKey,
  ModelView,
  RequestListView,
  TraceView,
  WorkspaceView,
} from '@lakka/contracts';
import { listSpansForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Reading traces (OB-1, AC 16, ADR 0075 H1, ADR 0079): workspace admins see every request in
 * their workspace; members see their own, made directly or through their keys; nobody sees
 * another workspace's, and keys read none. A trace comes back in tree order, with its attempts
 * and what they cost, and with what was said only where the workspace recorded it.
 */

let t: TestApp;
let fake: FakeProvider;
let base: string;
let root: SignedInUser;
let admin: SignedInUser;
let member: SignedInUser;
let colleague: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let model: ModelView;
let memberKey: IssuedKey;
const made: Record<'direct' | 'byKey' | 'colleague' | 'refused', string> = {
  direct: '',
  byKey: '',
  colleague: '',
  refused: '',
};

const suffix = () => randomBytes(3).toString('hex');
const requests = (ws = alpha) => `/api/workspaces/${ws.id}/requests`;

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', { name, slug: `${name}-${suffix()}` });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function chat(auth: { cookie: string } | { key: string }, body: object) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lakka-workspace': alpha.id,
      ...('key' in auth
        ? { authorization: `Bearer ${auth.key}` }
        : { cookie: auth.cookie, origin: PUBLIC_URL }),
    },
    body: JSON.stringify({ model: model.id, max_tokens: 100, ...body }),
  });
  await res.text();
  const requestId = res.headers.get('x-lakka-request-id') ?? '';
  for (let i = 0; i < 40; i += 1) {
    await t.tracing.forceFlush();
    if ((await listSpansForRequest(t.db, alpha.id, requestId)).some((s) => s.name === 'request'))
      return requestId;
    await sleep(50);
  }
  throw new Error('never traced');
}

const hello = { messages: [{ role: 'user', content: 'Hello' }] };

async function list(user: SignedInUser, query = ''): Promise<RequestListView> {
  const res = await as(t, user).get(`${requests()}${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as RequestListView;
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  [root, admin, member, colleague] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Member'),
    signedInUser(t, 'Colleague'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('alpha');
  bravo = await workspace('bravo');
  await as(t, root).put(`/api/workspaces/${alpha.id}/members/${admin.principal.id}`, {
    role: 'admin',
  });
  for (const user of [member, colleague]) {
    await as(t, root).put(`/api/workspaces/${alpha.id}/members/${user.principal.id}`, {
      role: 'member',
    });
  }
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  const created = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `ok~${suffix()}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
      pdf: false,
      tools: false,
      structuredOutput: false,
      promptCaching: false,
      reasoning: false,
    },
    prices: {
      inputMicroUsdPerMtok: 1_000_000,
      outputMicroUsdPerMtok: 2_000_000,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  });
  model = (created.json() as { model: ModelView }).model;
  memberKey = (
    await as(t, member).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Script' })
  ).json() as IssuedKey;

  made.direct = await chat(member, hello);
  made.byKey = await chat({ key: memberKey.secret }, hello);
  made.colleague = await chat(colleague, hello);
  // A refusal: a cap with no room.
  await as(t, root).put(`/api/workspaces/${alpha.id}/budgets/members/${colleague.principal.id}`, {
    limitMicroUsd: '1',
    period: 'monthly',
  });
  made.refused = await chat(colleague, hello);
});

afterAll(async () => {
  await fake?.close();
  await t?.close();
});

describe('the request list (OB-1, H1)', () => {
  it('H1: a workspace admin sees every request in the workspace, newest first', async () => {
    const page = await list(admin);
    expect(page.requests.map((r) => r.requestId)).toEqual([
      made.refused,
      made.colleague,
      made.byKey,
      made.direct,
    ]);
    const byKey = page.requests.find((r) => r.requestId === made.byKey);
    expect(byKey).toMatchObject({
      status: 'ok',
      surface: 'api',
      model: model.id,
      outcome: 'completed',
      principal: { kind: 'key', name: 'Script' },
      person: { id: member.principal.id, name: 'Member' },
    });
    expect(BigInt(byKey?.costMicroUsd ?? '0')).toBeGreaterThan(0n);
    expect(page.requests.find((r) => r.requestId === made.refused)).toMatchObject({
      status: 'error',
      errorType: 'budget_exceeded',
      costMicroUsd: '0',
    });
  });

  it("H1: a member sees their own requests, their keys' too, and nobody else's", async () => {
    expect((await list(member)).requests.map((r) => r.requestId)).toEqual([
      made.byKey,
      made.direct,
    ]);
    expect((await list(colleague)).requests.map((r) => r.requestId)).toEqual([
      made.refused,
      made.colleague,
    ]);
  });

  it('pages back with nextBefore', async () => {
    const first = await list(admin, '?limit=2');
    expect(first.requests).toHaveLength(2);
    expect(first.nextBefore).not.toBeNull();
    const second = await list(
      admin,
      `?limit=2&before=${encodeURIComponent(first.nextBefore ?? '')}`,
    );
    expect(second.requests.map((r) => r.requestId)).toEqual([made.byKey, made.direct]);
    const third = await list(
      admin,
      `?limit=2&before=${encodeURIComponent(second.nextBefore ?? '')}`,
    );
    // Every page counts every match, so the pager can say "Showing 3 to 4 of 4".
    expect(third).toEqual({ requests: [], nextBefore: null, total: first.total });
    expect(first.total).toBe(4);
  });

  it('AC 16: keys read no traces, and another workspace sees none of these', async () => {
    const byKey = await t.app.inject({
      method: 'GET',
      url: requests(),
      headers: { authorization: `Bearer ${memberKey.secret}` },
    });
    expect(byKey.statusCode).toBe(403);
    const other = await as(t, root).get(requests(bravo));
    expect((other.json() as RequestListView).requests).toEqual([]);
    expect((await as(t, root).get(`${requests(bravo)}/${made.direct}`)).statusCode).toBe(404);
  });
});

describe('one trace (OB-1)', () => {
  it('OB-1: comes in tree order, with its attempts and what they cost', async () => {
    const res = await as(t, admin).get(`${requests()}/${made.direct}`);
    expect(res.statusCode).toBe(200);
    const { trace } = res.json() as { trace: TraceView };
    expect(trace.request.requestId).toBe(made.direct);
    expect(trace.spans[0]).toMatchObject({ name: 'request', depth: 0, offsetMs: 0 });
    const names = trace.spans.map(
      (s) => `${s.depth}:${s.name.startsWith('chat ') ? 'chat' : s.name}`,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        '0:request',
        '1:policy.resolve_model',
        '1:gateway.dispatch',
        '2:chat',
      ]),
    );
    // A child comes after its parent.
    const dispatch = names.indexOf('1:gateway.dispatch');
    expect(names.indexOf('2:chat')).toBeGreaterThan(dispatch);
    expect(trace.attempts).toMatchObject([
      { attempt: 1, model: model.id, outcome: 'completed', inputTokens: 50, outputTokens: 8 },
    ]);
    expect(trace.attempts[0]?.costMicroUsd).toBe(trace.request.costMicroUsd);
    expect(trace.content).toEqual([]);
  });

  it("AC 16: a member cannot open someone else's trace, which is not found", async () => {
    expect((await as(t, member).get(`${requests()}/${made.colleague}`)).statusCode).toBe(404);
    expect((await as(t, member).get(`${requests()}/${made.byKey}`)).statusCode).toBe(200);
  });

  it('OB-4: shows what was said only where the workspace recorded it', async () => {
    await as(t, admin).put(`/api/workspaces/${alpha.id}/content-capture`, {
      enabled: true,
      retentionDays: 1,
    });
    try {
      const requestId = await chat(member, { messages: [{ role: 'user', content: 'Recorded' }] });
      const { trace } = (await as(t, member).get(`${requests()}/${requestId}`)).json() as {
        trace: TraceView;
      };
      expect(trace.content).toMatchObject([
        {
          prompt: { messages: [{ role: 'user', content: 'Recorded' }] },
          response: { text: 'Hello there' },
        },
      ]);
      const call = trace.spans.find((s) => s.name.startsWith('chat '));
      expect(trace.content[0]?.spanId).toBe(call?.spanId);
    } finally {
      await as(t, admin).put(`/api/workspaces/${alpha.id}/content-capture`, {
        enabled: false,
        retentionDays: 1,
      });
    }
  });
});

describe('what the request list and trace say (OB-1, ADR 0095)', () => {
  it('OB-1: each request says what was asked for, how the model was picked, and how it ended', async () => {
    const page = await list(admin);
    const direct = page.requests.find((r) => r.requestId === made.direct);
    expect(direct).toMatchObject({
      outcomeKind: 'completed',
      decision: { requested: model.id, rule: 'explicit', route: null },
      budget: null,
      toolDenied: false,
    });
    // BG-3: the cap that refused, and what it had left.
    expect(page.requests.find((r) => r.requestId === made.refused)).toMatchObject({
      outcomeKind: 'refused',
      budget: { scope: 'member', remainingMicroUsd: '1' },
    });
  });

  it('OB-1: filters by person, surface, outcome and dates, and counts every match', async () => {
    const ids = async (query: string) => {
      const page = await list(admin, query);
      return { ids: page.requests.map((r) => r.requestId), total: page.total };
    };
    const person = await ids(`?person=${member.principal.id}`);
    expect(person.ids).toEqual(expect.arrayContaining([made.byKey, made.direct]));
    expect(person.ids).not.toContain(made.colleague);
    expect(person.total).toBe(person.ids.length);
    expect((await ids('?surface=api')).ids).toEqual([made.byKey]);
    expect((await ids('?outcome=refused')).ids).toEqual([made.refused]);
    expect((await ids('?outcome=completed')).ids).not.toContain(made.refused);
    const today = new Date().toISOString().slice(0, 10);
    expect((await ids(`?from=${today}&to=${today}&surface=api`)).ids).toEqual([made.byKey]);
    expect((await ids('?from=2020-01-01&to=2020-01-31')).total).toBe(0);
    expect((await as(t, admin).get(`${requests()}?outcome=lost`)).statusCode).toBe(400);
    // AC 16: a member naming someone else still reads only their own.
    const theirs = await list(member, `?person=${colleague.principal.id}`);
    expect(theirs.requests.map((r) => r.requestId)).not.toContain(made.colleague);
  });

  it('OB-1: a trace starts with checking access, and the budget step says what the cap had', async () => {
    const { trace } = (await as(t, admin).get(`${requests()}/${made.refused}`)).json() as {
      trace: TraceView;
    };
    const names = trace.spans.map((span) => span.name);
    expect(names.indexOf('policy.authorize')).toBeLessThan(names.indexOf('policy.resolve_model'));
    const resolve = trace.spans.find((span) => span.name === 'policy.resolve_model');
    expect(resolve?.attributes).toMatchObject({ 'lakka.routing.requested': model.id });
    const hold = trace.spans.find((span) => span.name === 'policy.reserve_budget');
    expect(hold).toMatchObject({ status: 'error', errorType: 'budget_exceeded' });
    expect(hold?.attributes).toMatchObject({
      'lakka.budget.scope': 'member',
      'lakka.budget.remaining_micro_usd': 1,
    });
    expect(trace.attempts).toEqual([]);
  });

  it('TL-4: a request that paused for approval is read as one with the request that answered it', async () => {
    const asking = await chat(member, hello);
    const answering = await chat(member, hello);
    // What an answered approval leaves behind, written directly: the approval pointing from
    // the request that asked to the one that carried the answer, which says so on its span.
    await expect
      .poll(async () => (await list(admin, `?person=${member.principal.id}`)).requests.length)
      .toBeGreaterThanOrEqual(2);
    await t.pool.query(
      `update spans set attributes = attributes || jsonb_build_object('lakka.continues_request_id', $1::text)
       where request_id = $2 and name = 'request'`,
      [asking, answering],
    );
    await t.pool.query(
      `insert into tool_approvals (id, workspace_id, conversation_id, request_id, principal_id,
        tool_invocation_id, workspace_tool_id, tool_name, call_id, status, decided_by_principal_id,
        decided_at, continued_by_request_id, always)
       values (gen_random_uuid(), $1, gen_random_uuid(), $2, $3, gen_random_uuid(), gen_random_uuid(),
        'srv__deploy', 'c1', 'approved', $3, now(), $4, false)`,
      [alpha.id, asking, member.principal.id, answering],
    );
    const page = await list(admin, `?person=${member.principal.id}`);
    expect(page.requests.map((r) => r.requestId)).toContain(asking);
    expect(page.requests.map((r) => r.requestId)).not.toContain(answering);
    const row = page.requests.find((r) => r.requestId === asking);
    const alone = (await list(admin)).requests.find((r) => r.requestId === made.direct);
    // The chain costs both requests.
    expect(BigInt(row?.costMicroUsd ?? '0')).toBeGreaterThan(BigInt(alone?.costMicroUsd ?? '0'));

    // Either request opens the same trace, with both requests' steps and the wait.
    for (const id of [asking, answering]) {
      const { trace } = (await as(t, member).get(`${requests()}/${id}`)).json() as {
        trace: TraceView;
      };
      expect(trace.request.requestId).toBe(asking);
      expect(trace.spans.filter((span) => span.name === 'request')).toHaveLength(1);
      expect(trace.spans.filter((span) => span.name === 'policy.authorize')).toHaveLength(2);
      expect(new Set(trace.attempts.map((a) => a.requestId))).toEqual(new Set([asking, answering]));
      expect(trace.approvals).toMatchObject([
        {
          toolName: 'srv__deploy',
          status: 'approved',
          always: false,
          answeredBy: { id: member.principal.id, name: 'Member' },
        },
      ]);
    }
    expect((await as(t, colleague).get(`${requests()}/${answering}`)).statusCode).toBe(404);
  });
});
