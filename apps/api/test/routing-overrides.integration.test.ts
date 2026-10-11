import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelView, RouteView, RoutingOverridesView, WorkspaceView } from '@lakka/contracts';
import { ensureMonthlyPartitions, insertUsage } from '@lakka/db';
import type { UsageInsert } from '@lakka/db';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The override summary (RT-10, E11, ADR 0048) against real Postgres, from usage rows written
 * directly so every count and every micro-dollar can be checked exactly.
 */

let t: TestApp;
let admin: SignedInUser;
let member: SignedInUser;
let ws: WorkspaceView;
let other: WorkspaceView;
let models: { mid: string; cheap: string; strong: string };
let summary: RouteView;
let code: RouteView;

async function customModel(name: string, input: number, output: number): Promise<string> {
  const res = await as(t, admin).post('/api/models/custom', {
    provider: 'fake',
    model: `${name}-${randomBytes(3).toString('hex')}`,
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
      inputMicroUsdPerMtok: input,
      outputMicroUsdPerMtok: output,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { model: ModelView }).model.id;
}

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, admin).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${randomBytes(3).toString('hex')}`,
  });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function addRoute(name: string, model: string): Promise<RouteView> {
  const res = await as(t, admin).post(`/api/workspaces/${ws.id}/routes`, { name, model });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { route: RouteView }).route;
}

/** One usage row: 1M uncached input and 1M output tokens, costed at `cost` micro-USD. */
function row(overrides: Partial<UsageInsert>): UsageInsert {
  return {
    requestId: randomUUID(),
    attempt: 1,
    outcome: 'completed',
    surface: 'api',
    workspaceId: ws.id,
    principalId: member.principal.id,
    actingUserId: member.principal.id,
    model: models.cheap,
    provider: 'fake',
    providerConfigId: null,
    inputTokens: 1_000_000,
    uncachedInputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
    reasoningTokens: null,
    usageEstimated: false,
    inputMicroUsdPerMtok: 0,
    outputMicroUsdPerMtok: 0,
    cacheReadMicroUsdPerMtok: 0,
    cacheWriteMicroUsdPerMtok: 0,
    priceTierAboveInputTokens: null,
    costMicroUsd: 750_000n,
    finishReason: 'stop',
    latencyMs: 100,
    ttftMs: 10,
    resolutionRule: 'classified',
    routeId: summary.id,
    routeConfidence: 0.5,
    ...overrides,
  };
}

const override = (routeId: string, from: string, to: string, extra: Partial<UsageInsert> = {}) =>
  row({
    resolutionRule: 'explicit',
    routeId,
    routeConfidence: null,
    model: to,
    wasOverridden: true,
    overriddenModel: from,
    ...extra,
  });

const get = async (who: SignedInUser, workspaceId: string, query = '') =>
  as(t, who).get(`/api/workspaces/${workspaceId}/routing/overrides${query}`);

beforeAll(async () => {
  t = await createTestApp();
  [admin, member] = await Promise.all([signedInUser(t, 'Admin'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  ws = await workspace('Overrides');
  other = await workspace('Other');
  await as(t, admin).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
    role: 'member',
  });
  await as(t, admin).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  models = {
    // Blended prices: cheap 0.1875, mid 1.5, strong 6 (dollars per million tokens).
    cheap: await customModel('cheap', 150_000, 300_000),
    mid: await customModel('mid', 1_000_000, 3_000_000),
    strong: await customModel('strong', 4_000_000, 12_000_000),
  };
  summary = await addRoute('summary', models.cheap);
  code = await addRoute('code', models.mid);

  const rows: UsageInsert[] = [
    // Kept: three requests the summary route decided, one of them retried (two attempts).
    row({}),
    row({ resolutionRule: 'sticky' }),
    ...(() => {
      const requestId = randomUUID();
      return [
        row({
          requestId,
          attempt: 1,
          outcome: 'abandoned',
          costMicroUsd: 0n,
          outputTokens: 0,
          inputTokens: 1_000_000,
        }),
        row({ requestId, attempt: 2 }),
      ];
    })(),
    // Overrides of the summary route: three to strong, one to mid, one to strong that failed
    // over to mid (counted once, as strong).
    override(summary.id, models.cheap, models.strong),
    override(summary.id, models.cheap, models.strong),
    override(summary.id, models.cheap, models.mid),
    ...(() => {
      const requestId = randomUUID();
      return [
        override(summary.id, models.cheap, models.strong, { requestId, attempt: 1 }),
        override(summary.id, models.cheap, models.mid, { requestId, attempt: 2 }),
      ];
    })(),
    // The code route: one override to a cheaper model, and no kept requests.
    override(code.id, models.mid, models.cheap),
    // Not counted: another workspace, and a default that was not overridden.
    override(summary.id, models.cheap, models.strong, { workspaceId: other.id }),
    row({ resolutionRule: 'default', defaultReason: 'below_threshold', routeId: null }),
  ];
  for (const r of rows) await insertUsage(t.db, r);

  // Ten days old: inside the default 30 days, outside a week. Its month may be the previous one.
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await ensureMonthlyPartitions(t.pool, tenDaysAgo);
  const old = await insertUsage(t.db, override(summary.id, models.cheap, models.strong));
  await t.pool.query('update usage set created_at = $1 where request_id = $2', [
    tenDaysAgo,
    old.requestId,
  ]);
});

afterAll(async () => {
  await t.close();
});

describe('the override summary (RT-10)', () => {
  it('RT-10: counts overrides per route, which way they went, and the model users chose most', async () => {
    const res = await get(admin, ws.id);
    expect(res.statusCode).toBe(200);
    const view = res.json() as RoutingOverridesView;
    expect(view.days).toBe(30);
    expect(view.routes).toEqual([
      {
        routeId: summary.id,
        route: 'summary',
        routedRequests: 3,
        overrides: 5,
        towardsStronger: 5,
        towardsCheaper: 0,
        suggestion: {
          model: models.strong,
          overrides: 4,
          // Kept tokens: 4M input (one abandoned attempt read it too) and 3M output. On strong:
          // 4 * 4 + 3 * 12 = 52 dollars, against 3 * 0.75 = 2.25 paid.
          costEffectMicroUsd: String(52_000_000 - 2_250_000),
        },
      },
      {
        routeId: code.id,
        route: 'code',
        routedRequests: 0,
        overrides: 1,
        towardsStronger: 0,
        towardsCheaper: 1,
        suggestion: { model: models.cheap, overrides: 1, costEffectMicroUsd: '0' },
      },
    ]);
  });

  it('RT-10: a shorter period leaves out older overrides, and a deleted route keeps its counts without a name', async () => {
    const week = (await get(admin, ws.id, '?days=7')).json() as RoutingOverridesView;
    expect(week.days).toBe(7);
    expect(week.routes.map((r) => r.overrides)).toEqual([4, 1]);

    await as(t, admin).delete(`/api/workspaces/${ws.id}/routes/${code.id}`);
    const after = (await get(admin, ws.id)).json() as RoutingOverridesView;
    expect(after.routes.find((r) => r.routeId === code.id)).toMatchObject({
      route: null,
      overrides: 1,
    });
  });

  it('validates the period', async () => {
    for (const q of ['?days=0', '?days=91', '?days=week', '?other=1']) {
      expect((await get(admin, ws.id, q)).statusCode).toBe(400);
    }
  });

  it('AC 16, E10: members may not read it, and other workspaces cannot see it', async () => {
    expect((await get(member, ws.id)).statusCode).toBe(403);
    const outsider = await signedInUser(t, 'Outsider');
    expect((await get(outsider, ws.id)).statusCode).toBe(404);
    // The other workspace has an override row of its own, but no route of this one appears.
    const view = (await get(admin, other.id)).json() as RoutingOverridesView;
    expect(view.routes.map((r) => r.routeId)).toEqual([summary.id]);
    expect(view.routes[0]?.route).toBeNull();
  });
});
