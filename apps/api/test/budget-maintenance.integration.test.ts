import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetExceededError } from '@lakka/contracts';
import type { ModelView, Principal, WorkspaceView } from '@lakka/contracts';
import {
  cacheScript,
  chargeLines,
  counterKey,
  createLogger,
  policySnapshots,
  rebuildBudgetCounters,
  reserveBudget,
  settleReservation,
  startBudgetMaintenance,
  sweepExpiredReservations,
} from '@lakka/core';
import type { BudgetEngineContext, ChargeLine } from '@lakka/core';
import { createDb, createPool, insertUsage, uuidv7 } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { valkeyConfig } from '../../../test/integration/valkey.ts';
import { as, createTestApp, CREDENTIAL_KEY, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Keeping budgets honest without an operator (BG-6, invariant 5, AC 8, ADR 0052): the sweep of
 * lapsed reservations, the rebuild of Valkey counters from Postgres, the loop the worker runs,
 * and a process killed with SIGKILL in the middle of a stream. Real Postgres and Valkey.
 */

let t: TestApp;
let fake: FakeProvider;
let root: SignedInUser;
let member: SignedInUser;
let ws: WorkspaceView;
let ctx: BudgetEngineContext;
const keyPrefix = `budget-maint-test-${randomBytes(4).toString('hex')}:`;
const { logger } = createLogger({ level: 'silent', service: 'budget-maintenance-test' });
const DOLLAR = 1_000_000n;
const CAP = 100n * DOLLAR;
const CHILD = fileURLToPath(new URL('../../../test/integration/budget-child.ts', import.meta.url));

async function lines(now = new Date()): Promise<ChargeLine[]> {
  const snapshot = await policySnapshots({ db: t.db }).get(ws.id);
  if (snapshot === undefined) throw new Error('no snapshot');
  return chargeLines(snapshot, member.principal, now);
}

function reserve(amount: bigint, options: { now?: Date; ttlMs?: number } = {}) {
  return lines(options.now).then((l) =>
    reserveBudget(ctx, {
      requestId: randomUUID(),
      workspaceId: ws.id,
      principal: member.principal,
      lines: l,
      amountMicroUsd: amount,
      ...options,
    }),
  );
}

/** The most that can still be reserved, found by bisection on real reserves. */
async function headroom(): Promise<bigint> {
  let low = 0n;
  let high = CAP * 2n;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    try {
      await settleReservation(ctx, await reserve(mid), 0n);
      low = mid;
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      high = mid - 1n;
    }
  }
  return low;
}

async function state(requestId: string) {
  const { rows } = await t.pool.query<{ state: string; actual: string | null }>(
    `select state, actual_micro_usd::text as actual from reservations
     where request_id = $1 and state <> 'denied'`,
    [requestId],
  );
  return rows[0];
}

/** One usage row for a request, as dispatch would have written it, costing `cost`. */
async function recordUsage(requestId: string, cost: bigint, attempt = 1): Promise<void> {
  await insertUsage(t.db, {
    requestId,
    attempt,
    outcome: 'aborted',
    surface: 'api',
    workspaceId: ws.id,
    principalId: member.principal.id,
    actingUserId: member.principal.id,
    model: 'fake:m',
    provider: 'fake',
    providerConfigId: null,
    inputTokens: 10,
    uncachedInputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
    reasoningTokens: null,
    usageEstimated: true,
    inputMicroUsdPerMtok: 0,
    outputMicroUsdPerMtok: 0,
    cacheReadMicroUsdPerMtok: 0,
    cacheWriteMicroUsdPerMtok: 0,
    priceTierAboveInputTokens: null,
    costMicroUsd: cost,
    finishReason: null,
    latencyMs: 10,
    ttftMs: null,
    resolutionRule: 'explicit',
  });
}

const HSET = cacheScript(`redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) return 1`);
const HDEL = cacheScript(`return redis.call('HDEL', KEYS[1], ARGV[1])`);

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  ctx = { db: t.db, cache: t.cache, logger, keyPrefix };
  [root, member] = await Promise.all([signedInUser(t, 'Root'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  ws = (
    (
      await as(t, root).post('/api/workspaces', {
        name: 'Maintenance',
        slug: `maint-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  await as(t, root).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
    role: 'member',
  });
  await as(t, root).put(`/api/workspaces/${ws.id}/budgets/members/${member.principal.id}`, {
    limitMicroUsd: String(CAP),
    period: 'monthly',
  });
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('the sweep (BG-6)', () => {
  it('BG-6: a lapsed reservation is charged what its request recorded, marked abandoned, and its hold released', async () => {
    const start = await headroom();
    const lapsed = await reserve(5n * DOLLAR, { now: new Date(Date.now() - 20 * 60 * 1000) });
    const current = await reserve(3n * DOLLAR);
    await recordUsage(lapsed.requestId, 700_000n);
    expect(await headroom()).toBe(start - 8n * DOLLAR);

    expect(await sweepExpiredReservations(ctx)).toBe(1);
    expect(await state(lapsed.requestId)).toEqual({ state: 'abandoned', actual: '700000' });
    expect(await state(current.requestId)).toEqual({ state: 'active', actual: null });
    expect(await headroom()).toBe(start - 3n * DOLLAR - 700_000n);
    // Nothing is swept twice.
    expect(await sweepExpiredReservations(ctx)).toBe(0);
    await settleReservation(ctx, current, 0n);
  });

  it('BG-6: a lapsed later round of a request is charged only what earlier rounds did not settle', async () => {
    // A tool loop holds one round at a time under one request id (ADR 0071, ADR 0089).
    const start = await headroom();
    const requestId = randomUUID();
    const hold = (now: Date) =>
      lines(now).then((l) =>
        reserveBudget(ctx, {
          requestId,
          workspaceId: ws.id,
          principal: member.principal,
          lines: l,
          amountMicroUsd: DOLLAR,
          now,
        }),
      );
    const first = await hold(new Date());
    await recordUsage(requestId, 300_000n, 1);
    await settleReservation(ctx, first, 300_000n);
    await hold(new Date(Date.now() - 20 * 60 * 1000));
    await recordUsage(requestId, 200_000n, 2);

    expect(await sweepExpiredReservations(ctx)).toBe(1);
    const { rows } = await t.pool.query<{ state: string; actual: string | null }>(
      `select state, actual_micro_usd::text as actual from reservations
       where request_id = $1 order by created_at`,
      [requestId],
    );
    expect(rows).toEqual([
      { state: 'settled', actual: '300000' },
      { state: 'abandoned', actual: '200000' },
    ]);
    expect(await headroom()).toBe(start - 500_000n);
  });

  it('BG-4: with Postgres unreachable the sweep releases nothing it has not charged', async () => {
    const lapsed = await reserve(DOLLAR, { now: new Date(Date.now() - 20 * 60 * 1000) });
    const before = await headroom();
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
    await expect(sweepExpiredReservations({ ...ctx, db: createDb(deadPool) })).rejects.toThrow(
      /Failed query|ECONNREFUSED/,
    );
    await deadPool.end();
    expect(await headroom()).toBe(before);
    expect(await state(lapsed.requestId)).toMatchObject({ state: 'active' });
    await sweepExpiredReservations(ctx);
    expect(await state(lapsed.requestId)).toEqual({ state: 'abandoned', actual: '0' });
  });
});

describe('the rebuild (invariant 5)', () => {
  it('invariant 5: drifted counters are rewritten from Postgres, keeping holds that began after the read', async () => {
    const live = await reserve(4n * DOLLAR);
    const exact = await headroom();
    const [line] = (await lines()).filter((l) => l.scope === 'member');
    if (line === undefined) throw new Error('no member line');
    const key = counterKey(keyPrefix, line.budgetId, line.periodStart);

    // Drift three ways: spend lost, a stale hold from a finished request, and a live hold missing.
    await t.cache.runScript(HSET, [key], ['spent', '0']);
    await t.cache.runScript(
      HSET,
      [key],
      [`r:${uuidv7(Date.now() - 10 * 60 * 1000)}`, String(DOLLAR)],
    );
    await t.cache.runScript(HDEL, [key], [`r:${live.id}`]);
    // And a hold from a reservation that began just now, which the rebuild must not drop.
    const fresh = uuidv7(Date.now() + 5_000);
    await t.cache.runScript(HSET, [key], [`r:${fresh}`, String(2n * DOLLAR)]);

    expect(await rebuildBudgetCounters(ctx)).toBeGreaterThan(0);
    expect(await headroom()).toBe(exact - 2n * DOLLAR);
    await t.cache.runScript(HDEL, [key], [`r:${fresh}`]);
    expect(await headroom()).toBe(exact);
    await settleReservation(ctx, live, 0n);
  });
});

describe('the worker loop (BG-6)', () => {
  it('BG-6: running maintenance releases a lapsed hold within its interval, even with two workers at once', async () => {
    const before = await headroom();
    const lapsing = await reserve(6n * DOLLAR, { ttlMs: 1 });
    const stopA = startBudgetMaintenance(ctx, t.pool, { intervalMs: 100 });
    const stopB = startBudgetMaintenance(ctx, t.pool, { intervalMs: 100 });
    try {
      await expect
        .poll(async () => (await state(lapsing.requestId))?.state, { timeout: 5000 })
        .toBe('abandoned');
    } finally {
      await stopA();
      await stopB();
    }
    expect(await state(lapsing.requestId)).toEqual({ state: 'abandoned', actual: '0' });
    expect(await headroom()).toBe(before);
  });

  it('AC 8: killing the process mid-stream leaves no reservation held; it is released within the orphan window', async () => {
    const provider = await as(t, root).post('/api/providers', {
      kind: 'openai-compatible',
      name: 'fake',
      baseUrl: `${fake.url}/openai/v1`,
    });
    expect(provider.statusCode).toBe(201);
    const model = (
      (
        await as(t, root).post('/api/models/custom', {
          provider: 'fake',
          model: `slow~${randomBytes(3).toString('hex')}`,
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
        })
      ).json() as { model: ModelView }
    ).model;
    const before = await headroom();
    const requestId = randomUUID();
    const ttlMs = 3000;
    const principal: Principal = member.principal;
    const child = spawn(process.execPath, [CHILD], {
      env: {
        ...process.env,
        LAKKA_TEST_CHILD: JSON.stringify({
          database: t.database.options(),
          cache: { host: valkeyConfig().host, port: valkeyConfig().port },
          credentialKey: CREDENTIAL_KEY,
          keyPrefix,
          workspaceId: ws.id,
          principal,
          model: model.id,
          requestId,
          reservationTtlMs: ttlMs,
          maxRequestMs: ttlMs - 1000,
        }),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('streaming')) resolve();
      });
      child.on('exit', (code) => reject(new Error(`child exited early with ${code}`)));
    });
    const killed = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGKILL');
    await killed;

    // Mid-stream: held, and nothing settled it.
    expect(await state(requestId)).toMatchObject({ state: 'active' });
    expect(await headroom()).toBeLessThan(before);

    const stop = startBudgetMaintenance(ctx, t.pool, { intervalMs: 200 });
    const killedAt = Date.now();
    try {
      await expect
        .poll(async () => (await state(requestId))?.state, { timeout: ttlMs + 5000 })
        .toBe('abandoned');
    } finally {
      await stop();
    }
    // Within the window: the hold's lifetime plus one sweep interval, with a little slack.
    expect(Date.now() - killedAt).toBeLessThan(ttlMs + 2000);
    expect(await headroom()).toBe(before);
  });
});
