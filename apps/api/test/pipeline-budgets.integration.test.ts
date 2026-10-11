import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, UnknownModelError } from '@lakka/contracts';
import type { ModelView, WorkspaceView } from '@lakka/contracts';
import {
  createLogger,
  estimateAttemptCost,
  handleModelRequest,
  fixedCatalogue,
  loadCatalogue,
  noClassifier,
  policySnapshots,
  valkeyEvents,
} from '@lakka/core';
import type { ModelRequest, ModelResponse, PipelineContext } from '@lakka/core';
import { createDb, createPool, listUsageForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Budgets in the request path (BG-2, BG-3, BG-5, invariant 4, AC 7, AC 10, ADR 0051): every
 * request through the one entry point reserves its estimate before anything is sent, and settles
 * the recorded cost however it ends. Real Postgres and Valkey, and a fake provider over HTTP.
 */

let t: TestApp;
let fake: FakeProvider;
let root: SignedInUser;
let member: SignedInUser;
let ws: WorkspaceView;
let ctx: PipelineContext;
const { logger } = createLogger({ level: 'silent', service: 'pipeline-budgets-test' });
const catalogue = fixedCatalogue(loadCatalogue());

const PROMPT = 'Tell me something useful';
const MAX_OUTPUT = 1000;

async function customModel(scenario: string): Promise<ModelView> {
  const res = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `${scenario}~${randomBytes(3).toString('hex')}`,
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
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { model: ModelView }).model;
}

const providerModel = (m: ModelView) => m.model;

function request(model: string, extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: randomUUID(),
    surface: 'api',
    workspaceId: ws.id,
    principal: member.principal,
    request: { messages: [{ role: 'user', content: PROMPT }], maxOutputTokens: MAX_OUTPUT },
    model,
    conversationId: null,
    ...extra,
  };
}

async function drain(response: ModelResponse): Promise<void> {
  try {
    for await (const event of response.stream) void event;
  } catch {
    // Interrupted or aborted streams end with an error; the tests look at what was settled.
  }
  await response.stream.done.catch(() => undefined);
}

async function setMemberCap(microUsd: bigint): Promise<void> {
  const res = await as(t, root).put(
    `/api/workspaces/${ws.id}/budgets/members/${member.principal.id}`,
    { limitMicroUsd: String(microUsd), period: 'monthly' },
  );
  if (res.statusCode !== 200) throw new Error(res.body);
}

async function reservationFor(requestId: string) {
  const { rows } = await t.pool.query<{ state: string; amount: string; actual: string | null }>(
    `select state, amount_micro_usd::text as amount, actual_micro_usd::text as actual
     from reservations where request_id = $1 and state <> 'denied'`,
    [requestId],
  );
  return rows[0];
}

async function recordedCost(requestId: string): Promise<bigint> {
  const rows = await listUsageForRequest(t.db, ws.id, requestId);
  return rows.reduce((sum, r) => sum + r.costMicroUsd, 0n);
}

async function memberSpend(): Promise<bigint> {
  const { rows } = await t.pool.query<{ spent: string | null }>(
    `select sum(s.spent_micro_usd)::text as spent from budget_spend s
     join budgets b on b.id = s.budget_id where b.scope = 'member' and b.principal_id = $1`,
    [member.principal.id],
  );
  return BigInt(rows[0]?.spent ?? '0');
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  [root, member] = await Promise.all([signedInUser(t, 'Root'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  ws = (
    (
      await as(t, root).post('/api/workspaces', {
        name: 'Metered',
        slug: `metered-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  await as(t, root).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
    role: 'member',
  });
  const provider = await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  if (provider.statusCode !== 201) throw new Error(provider.body);
  ctx = {
    db: t.db,
    catalogue,
    logger,
    events: valkeyEvents(t.cache, logger),
    cache: t.cache,
    keyPrefix: `pipeline-budget-test-${randomBytes(4).toString('hex')}:`,
    classifier: noClassifier,
    snapshots: policySnapshots({ db: t.db }),
    timeouts: {
      firstChunkMs: 2000,
      reasoningFirstChunkMs: 2000,
      idleMs: 2000,
      reasoningIdleMs: 2000,
    },
    attemptsPerModel: 2,
    backoffMs: () => 5,
  };
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('reserving before sending (BG-2, BG-3)', () => {
  it('BG-3, AC 7: 50 concurrent requests against a budget that covers 10 send at most 10, with no breach', async () => {
    const slow = await customModel('slow');
    const estimate = estimateAttemptCost(request(slow.id).request, slow);
    // Room for ten estimates, and half of an eleventh.
    const cap = estimate * 10n + estimate / 2n;
    await setMemberCap(cap);
    const before = await memberSpend();

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => handleModelRequest(ctx, request(slow.id))),
    );
    const granted = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(granted).toHaveLength(10);
    for (const error of refused) expect(error).toBeInstanceOf(BudgetExceededError);
    expect(fake.count(providerModel(slow))).toBe(10);
    for (const response of granted) expect(response.reservedMicroUsd).toBe(estimate);

    await Promise.all(granted.map(drain));
    const spend = (await memberSpend()) - before;
    expect(spend).toBeGreaterThan(0n);
    expect(spend).toBeLessThanOrEqual(cap);
  });

  it('BG-2, AC 10: a request whose maximum possible output would pass the remaining budget is refused before anything is sent', async () => {
    const ok = await customModel('ok');
    await setMemberCap(estimateAttemptCost(request(ok.id).request, ok) - 1n);
    const req = request(ok.id);
    await expect(handleModelRequest(ctx, req)).rejects.toMatchObject({
      code: 'budget_exceeded',
      scope: 'member',
    });
    expect(fake.count(providerModel(ok))).toBe(0);
    expect(await listUsageForRequest(t.db, ws.id, req.requestId)).toEqual([]);
    // The same request asking for less output fits.
    const smaller = request(ok.id, {
      request: { messages: [{ role: 'user', content: PROMPT }], maxOutputTokens: MAX_OUTPUT / 2 },
    });
    await drain(await handleModelRequest(ctx, smaller));
    expect(fake.count(providerModel(ok))).toBe(1);
  });

  it('BG-4, AC 9: with Postgres unreachable, a request is refused with a clear error and nothing is sent', async () => {
    const ok = await customModel('ok');
    const before = fake.requests.length;
    const deadPool = createPool(
      {
        host: '127.0.0.1',
        port: 1,
        user: 'x',
        password: undefined,
        database: 'x',
        applicationName: 'dead',
      },
      () => undefined,
    );
    const dead = createDb(deadPool);
    const error = await handleModelRequest(
      { ...ctx, db: dead, snapshots: policySnapshots({ db: dead }) },
      request(ok.id),
    ).catch((e: unknown) => e);
    await deadPool.end();
    expect(error).toBeInstanceOf(BudgetUnavailableError);
    expect(error).toMatchObject({ code: 'budget_unavailable' });
    expect(fake.requests.length).toBe(before);
  });

  it('BG-4: a model with no price is refused before anything is reserved or sent', async () => {
    await setMemberCap(1_000_000_000n);
    const req = request('fake:unpriced-model');
    await expect(handleModelRequest(ctx, req)).rejects.toBeInstanceOf(UnknownModelError);
    expect(await reservationFor(req.requestId)).toBeUndefined();
  });
});

describe('settling however the request ends (BG-5, invariant 4)', () => {
  it('BG-5: a completed request is settled with exactly its recorded cost, and the rest is released', async () => {
    await setMemberCap(1_000_000_000n);
    const ok = await customModel('ok');
    const req = request(ok.id);
    const before = await memberSpend();
    await drain(await handleModelRequest(ctx, req));
    const cost = await recordedCost(req.requestId);
    expect(cost).toBeGreaterThan(0n);
    const reservation = await reservationFor(req.requestId);
    expect(reservation).toMatchObject({ state: 'settled', actual: String(cost) });
    expect(BigInt(reservation?.amount ?? '0')).toBeGreaterThan(cost);
    expect((await memberSpend()) - before).toBe(cost);
  });

  it('invariant 4: a client that disconnects mid-stream is charged its partial usage, and the rest is released', async () => {
    const slow = await customModel('slow');
    const controller = new AbortController();
    const req = request(slow.id, { signal: controller.signal });
    const response = await handleModelRequest(ctx, req);
    const before = await memberSpend();
    try {
      for await (const event of response.stream) {
        if (event.type === 'text') controller.abort();
      }
    } catch {
      // The abort ends the stream with an error.
    }
    await response.stream.done.catch(() => undefined);
    const cost = await recordedCost(req.requestId);
    expect(cost).toBeGreaterThan(0n);
    const reservation = await reservationFor(req.requestId);
    expect(reservation).toMatchObject({ state: 'settled', actual: String(cost) });
    expect(cost).toBeLessThan(BigInt(reservation?.amount ?? '0'));
    expect((await memberSpend()) - before).toBe(cost);
    const rows = await listUsageForRequest(t.db, ws.id, req.requestId);
    expect(rows.map((r) => r.outcome)).toEqual(['aborted']);
  });

  it('invariant 4: a request that fails before streaming is settled with what its attempts cost', async () => {
    const failing = await customModel('status-503');
    const req = request(failing.id);
    await expect(handleModelRequest(ctx, req)).rejects.toMatchObject({
      code: 'upstream_unavailable',
    });
    const reservation = await reservationFor(req.requestId);
    expect(reservation).toMatchObject({
      state: 'settled',
      actual: String(await recordedCost(req.requestId)),
    });
  });

  it('invariant 4: a request that runs past its limit is aborted and settled before its hold can lapse', async () => {
    const slow = await customModel('slow');
    const req = request(slow.id);
    const response = await handleModelRequest({ ...ctx, maxRequestMs: 300 }, req);
    await drain(response);
    const rows = await listUsageForRequest(t.db, ws.id, req.requestId);
    expect(rows.map((r) => r.outcome)).toEqual(['aborted']);
    expect(await reservationFor(req.requestId)).toMatchObject({ state: 'settled' });
  });

  it('BG-3: a workspace with no caps is not metered at all', async () => {
    const removed = await as(t, root).delete(
      `/api/workspaces/${ws.id}/budgets/members/${member.principal.id}`,
    );
    expect(removed.statusCode).toBe(204);
    const ok = await customModel('ok');
    const req = request(ok.id);
    const response = await handleModelRequest(ctx, req);
    expect(response.reservedMicroUsd).toBeNull();
    await drain(response);
    expect(await reservationFor(req.requestId)).toBeUndefined();
  });
});
