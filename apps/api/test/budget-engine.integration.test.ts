import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  BudgetUnavailableError,
  periodEnd,
  periodStart,
} from '@lakka/contracts';
import type { Principal, WorkspaceView } from '@lakka/contracts';
import {
  cacheScript,
  chargeLines,
  counterKey,
  createCacheClient,
  createLogger,
  policySnapshots,
  reserveBudget,
  settleReservation,
} from '@lakka/core';
import type { BudgetEngineContext, ChargeLine, Reservation } from '@lakka/core';
import { createDb, createPool } from '@lakka/db';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The reservation engine under failure (BG-3, BG-4, BG-5, BG-9, invariant 4, invariant 5; tech
 * spec, Budget enforcement, Test plan), against real Postgres and Valkey. Written before the
 * engine, as the spec asks. The request path and the orphan sweep have their own tests
 * (pipeline-budgets, budget-maintenance).
 */

let t: TestApp;
let root: SignedInUser;
let member: SignedInUser;
let colleague: SignedInUser;
let ws: WorkspaceView;
const logs: string[] = [];
const { logger } = createLogger({
  level: 'debug',
  service: 'budget-engine-test',
  destination: { write: (line: string) => void logs.push(line) },
});
const keyPrefix = `budget-test-${randomBytes(4).toString('hex')}:`;
let ctx: BudgetEngineContext;

const DOLLAR = 1_000_000n;

async function setCap(path: string, dollars: number, period = 'monthly'): Promise<void> {
  const res = await as(t, root).put(path, {
    limitMicroUsd: String(BigInt(dollars) * DOLLAR),
    period,
  });
  if (res.statusCode !== 200) throw new Error(res.body);
}

async function linesFor(principal: Principal, now = new Date()): Promise<ChargeLine[]> {
  const snapshot = await policySnapshots({ db: t.db }).get(ws.id);
  if (snapshot === undefined) throw new Error('no snapshot');
  return chargeLines(snapshot, principal, now);
}

function reserve(principal: Principal, lines: readonly ChargeLine[], amount: bigint, now?: Date) {
  return reserveBudget(ctx, {
    requestId: randomUUID(),
    workspaceId: ws.id,
    principal,
    lines,
    amountMicroUsd: amount,
    ...(now === undefined ? {} : { now }),
  });
}

async function reservationState(id: string) {
  const { rows } = await t.pool.query<{ state: string; actual: string | null }>(
    'select state, actual_micro_usd::text as actual from reservations where id = $1',
    [id],
  );
  return rows[0];
}

async function spent(budgetId: string, start: Date): Promise<bigint> {
  const { rows } = await t.pool.query<{ spent: string }>(
    'select spent_micro_usd::text as spent from budget_spend where budget_id = $1 and period_start = $2',
    [budgetId, start],
  );
  return BigInt(rows[0]?.spent ?? '0');
}

/** The most that can still be reserved for `principal`, found by bisection on real reserves. */
async function headroom(principal: Principal): Promise<bigint> {
  const lines = await linesFor(principal);
  let low = 0n;
  let high = 1_000n * DOLLAR;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    try {
      const r = await reserve(principal, lines, mid);
      await settleReservation(ctx, r, 0n);
      low = mid;
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      high = mid - 1n;
    }
  }
  return low;
}

const DELETE_KEYS = cacheScript(`
for _, key in ipairs(KEYS) do redis.call('DEL', key) end
return #KEYS
`);

beforeAll(async () => {
  t = await createTestApp();
  ctx = { db: t.db, cache: t.cache, logger, keyPrefix };
  [root, member, colleague] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Member'),
    signedInUser(t, 'Colleague'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  ws = (
    (
      await as(t, root).post('/api/workspaces', {
        name: 'Budgets',
        slug: `budgets-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  for (const user of [member, colleague]) {
    await as(t, root).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
      role: 'member',
    });
  }
});

afterAll(async () => {
  await t.close();
});

describe('reserving (BG-3)', () => {
  it('BG-3, AC 7: 50 concurrent reservations against room for 10 grant exactly 10, and the cap holds', async () => {
    await setCap(`/api/workspaces/${ws.id}/budgets/members/${member.principal.id}`, 10);
    const lines = await linesFor(member.principal);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => reserve(member.principal, lines, DOLLAR)),
    );
    const granted = results.filter((r) => r.status === 'fulfilled');
    const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(granted).toHaveLength(10);
    expect(refused).toHaveLength(40);
    for (const error of refused) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect(error).toMatchObject({ scope: 'member', remainingMicroUsd: 0n });
    }
    const { rows } = await t.pool.query<{ state: string; n: number }>(
      `select state, count(*)::int as n from reservations where principal_id = $1
       group by state order by state`,
      [member.principal.id],
    );
    expect(rows).toEqual([
      { state: 'active', n: 10 },
      { state: 'denied', n: 40 },
    ]);
    // Not a micro-dollar more fits.
    await expect(reserve(member.principal, lines, 1n)).rejects.toBeInstanceOf(BudgetExceededError);
    for (const r of granted) {
      if (r.status === 'fulfilled') await settleReservation(ctx, r.value, 0n);
    }
    expect(await headroom(member.principal)).toBe(10n * DOLLAR);
  });

  it('BG-1: nested caps: a member at their cap is refused while a colleague gets through, and the workspace cap binds both', async () => {
    await setCap(`/api/workspaces/${ws.id}/budgets/workspace`, 15);
    const mine = await reserve(member.principal, await linesFor(member.principal), 10n * DOLLAR);
    await expect(
      reserve(member.principal, await linesFor(member.principal), 1n),
    ).rejects.toMatchObject({ scope: 'member' });
    // The colleague has no member cap, only the workspace's 5 dollars left.
    const theirs = await reserve(
      colleague.principal,
      await linesFor(colleague.principal),
      5n * DOLLAR,
    );
    await expect(
      reserve(colleague.principal, await linesFor(colleague.principal), 1n),
    ).rejects.toMatchObject({ scope: 'workspace', remainingMicroUsd: 0n });
    await settleReservation(ctx, mine, 0n);
    await settleReservation(ctx, theirs, 0n);
  });

  it('BG-3: a request with no caps that apply is not held anywhere', async () => {
    const r = await reserve(colleague.principal, [], 5n * DOLLAR);
    expect(r.lines).toEqual([]);
    expect(await reservationState(r.id)).toBeUndefined();
    expect(await settleReservation(ctx, r, 3n * DOLLAR)).toMatchObject({ settled: true });
  });
});

describe('settling (BG-5)', () => {
  it('BG-5: settling charges the actual cost to Postgres, releases the rest, and happens only once', async () => {
    const lines = await linesFor(member.principal);
    const before = await headroom(member.principal);
    const r = await reserve(member.principal, lines, 3n * DOLLAR);
    expect(await reservationState(r.id)).toEqual({ state: 'active', actual: null });
    expect(await settleReservation(ctx, r, DOLLAR)).toEqual({
      settled: true,
      actualMicroUsd: DOLLAR,
      overageMicroUsd: 0n,
    });
    expect(await reservationState(r.id)).toEqual({ state: 'settled', actual: String(DOLLAR) });
    const memberLine = lines.find((l) => l.scope === 'member');
    expect(memberLine).toBeDefined();
    if (memberLine === undefined) return;
    expect(await spent(memberLine.budgetId, memberLine.periodStart)).toBe(DOLLAR);
    expect(await headroom(member.principal)).toBe(before - DOLLAR);

    // Settling again changes nothing.
    expect(await settleReservation(ctx, r, 2n * DOLLAR)).toMatchObject({ settled: false });
    expect(await spent(memberLine.budgetId, memberLine.periodStart)).toBe(DOLLAR);
    expect(await headroom(member.principal)).toBe(before - DOLLAR);
  });

  it('BG-5: an actual cost above the reservation is charged in full and logged as an anomaly', async () => {
    const lines = await linesFor(member.principal);
    const memberLine = lines.find((l) => l.scope === 'member');
    if (memberLine === undefined) throw new Error('no member line');
    const before = await spent(memberLine.budgetId, memberLine.periodStart);
    const r = await reserve(member.principal, lines, DOLLAR);
    expect(await settleReservation(ctx, r, 2n * DOLLAR)).toEqual({
      settled: true,
      actualMicroUsd: 2n * DOLLAR,
      overageMicroUsd: DOLLAR,
    });
    expect(await spent(memberLine.budgetId, memberLine.periodStart)).toBe(before + 2n * DOLLAR);
    expect(logs.join('\n')).toContain('"msg":"budget.overage"');
  });

  it('BG-9: a request reserved before its period ends is charged to that period, and the next period starts fresh', async () => {
    const key = `/api/workspaces/${ws.id}/budgets/members/${colleague.principal.id}`;
    await setCap(key, 4, 'daily');
    const today = periodStart('daily', new Date());
    const lastSecond = new Date((periodEnd('daily', today)?.getTime() ?? 0) - 1000);
    const tomorrow = new Date(lastSecond.getTime() + 2000);
    const lines = await linesFor(colleague.principal, lastSecond);
    const r = await reserve(colleague.principal, lines, 3n * DOLLAR, lastSecond);
    // Midnight passes while the request runs; tomorrow's period has the whole cap.
    const next = await reserve(
      colleague.principal,
      await linesFor(colleague.principal, tomorrow),
      4n * DOLLAR,
      tomorrow,
    );
    await settleReservation(ctx, r, 2n * DOLLAR);
    const memberLine = lines.find((l) => l.scope === 'member');
    if (memberLine === undefined) throw new Error('no member line');
    expect(memberLine.periodStart).toEqual(today);
    expect(await spent(memberLine.budgetId, today)).toBe(2n * DOLLAR);
    expect(await spent(memberLine.budgetId, periodStart('daily', tomorrow))).toBe(0n);
    await settleReservation(ctx, next, 0n);
    await t.pool.query('delete from budgets where id = $1', [memberLine.budgetId]);
  });
});

describe('failing closed (BG-4)', () => {
  it('BG-4, AC 9: with Postgres unreachable, the request is refused and nothing is held', async () => {
    const lines = await linesFor(member.principal);
    const before = await headroom(member.principal);
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
    const dead: BudgetEngineContext = { ...ctx, db: createDb(deadPool) };
    await expect(
      reserveBudget(dead, {
        requestId: randomUUID(),
        workspaceId: ws.id,
        principal: member.principal,
        lines,
        amountMicroUsd: DOLLAR,
      }),
    ).rejects.toBeInstanceOf(BudgetUnavailableError);
    await deadPool.end();
    expect(await headroom(member.principal)).toBe(before);
  });

  it('BG-4: with Valkey unreachable, the request is refused and no reservation is left outstanding', async () => {
    const lines = await linesFor(member.principal);
    const deadCache = createCacheClient(
      { host: '127.0.0.1', port: 1, password: undefined },
      'dead',
    );
    const requestId = randomUUID();
    await expect(
      reserveBudget(
        { ...ctx, cache: deadCache },
        {
          requestId,
          workspaceId: ws.id,
          principal: member.principal,
          lines,
          amountMicroUsd: DOLLAR,
        },
      ),
    ).rejects.toBeInstanceOf(BudgetUnavailableError);
    deadCache.close();
    const { rows } = await t.pool.query<{ state: string }>(
      'select state from reservations where request_id = $1',
      [requestId],
    );
    expect(rows.every((r) => r.state !== 'active' && r.state !== 'pending')).toBe(true);
  });
});

describe('Valkey is a cache (invariant 5)', () => {
  it('invariant 5: counters lost from Valkey are rebuilt from Postgres, outstanding reservations included', async () => {
    const lines = await linesFor(member.principal);
    const outstanding: Reservation = await reserve(member.principal, lines, 2n * DOLLAR);
    const before = await headroom(member.principal);

    // Lose every counter this test's caps use, as a flush would.
    await t.cache.runScript(
      DELETE_KEYS,
      lines.map((l) => counterKey(keyPrefix, l.budgetId, l.periodStart)),
      [],
    );
    expect(await headroom(member.principal)).toBe(before);

    // The rebuilt counter still knows the outstanding hold, and releases it once settled.
    await settleReservation(ctx, outstanding, 0n);
    expect(await headroom(member.principal)).toBe(before + 2n * DOLLAR);
  });
});
