import { periodStart } from '@lakka/contracts';
import type { BudgetPeriod } from '@lakka/contracts';
import {
  chargeReservation,
  listExpiredReservations,
  listRebuildTargets,
  listUsageForRequest,
  loadCounterSeeds,
  sumChargedForRequest,
  withAdvisoryLock,
} from '@lakka/db';
import type { Pool, ReservationLineRow } from '@lakka/db';
import { cacheScript } from '../cache.ts';
import { enqueuePendingAlerts } from './alerts.ts';
import type { AlertSender } from './alerts.ts';
import { counterExpiry, counterKey, DEFAULT_KEY_PREFIX, RELEASE } from './engine.ts';
import type { BudgetEngineContext } from './engine.ts';

/*
 * Keeping budgets honest without an operator (BG-6, invariant 5, ADR 0052).
 *
 * The sweep settles reservations whose hold lapsed: a process killed mid-stream, or a client that
 * never finished reading. Each is charged what its request's usage rows recorded, marked
 * 'abandoned', and its hold is released. Postgres is charged first, so a sweep that fails halfway
 * never releases a hold it did not charge.
 *
 * The rebuild rewrites every current counter from Postgres, so drift between Valkey and Postgres
 * (a release that failed, a rebuild racing a settle) corrects itself instead of building up.
 *
 * Each round also hands threshold alerts recorded since the last one to the job queue (ADR 0054).
 */

/** Holds created within this long before a rebuild read are kept, to absorb clock skew. */
const REBUILD_SKEW_MS = 60_000;
const MAINTENANCE_LOCK_KEY = 0x62756467; // "budg"

/*
 * KEYS: one counter. ARGV: expiry, spent, cutoff id, then pairs of reservation id and amount.
 * Replaces the counter with what Postgres says, but keeps holds newer than the cutoff: those
 * reservations began after Postgres was read and must not be dropped.
 */
const REBUILD = cacheScript(`
local key = KEYS[1]
local keep = {}
local values = redis.call('HGETALL', key)
for j = 1, #values, 2 do
  local name = values[j]
  if string.sub(name, 1, 2) == 'r:' and string.sub(name, 3) >= ARGV[3] then
    keep[name] = values[j + 1]
  end
end
redis.call('DEL', key)
redis.call('HSET', key, 'spent', ARGV[2])
for j = 4, #ARGV, 2 do
  redis.call('HSET', key, 'r:' .. ARGV[j], ARGV[j + 1])
end
for name, amount in pairs(keep) do
  if redis.call('HEXISTS', key, name) == 0 then redis.call('HSET', key, name, amount) end
end
local expiry = tonumber(ARGV[1])
if expiry > 0 then redis.call('PEXPIREAT', key, expiry) end
return 1
`);

/** The smallest UUIDv7 for a time, so ids compare with it as their creation times do. */
function uuidv7Floor(ms: number): string {
  const hex = Math.max(0, ms).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/** Settles reservations whose hold lapsed before `now`. Returns how many it settled. */
export async function sweepExpiredReservations(
  ctx: BudgetEngineContext,
  now: Date = new Date(),
  limit = 100,
): Promise<number> {
  const prefix = ctx.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const expired = await listExpiredReservations(ctx.db, now, limit);
  let settled = 0;
  for (const reservation of expired) {
    const rows = await listUsageForRequest(ctx.db, reservation.workspaceId, reservation.requestId);
    const used = rows.reduce((sum, r) => sum + r.costMicroUsd, 0n);
    // A tool loop's earlier rounds settled their own attempts; charge only what they did not.
    const earlier = await sumChargedForRequest(
      ctx.db,
      reservation.workspaceId,
      reservation.requestId,
      reservation.id,
    );
    const actual = used > earlier ? used - earlier : 0n;
    if (!(await chargeReservation(ctx.db, reservation.id, actual, 'abandoned'))) continue;
    settled += 1;
    try {
      await ctx.cache.runScript(
        RELEASE,
        reservation.lines.map((l) => counterKey(prefix, l.budgetId, l.periodStart)),
        [reservation.id, String(actual)],
      );
    } catch (error) {
      // Charged in Postgres; the stale hold only tightens caps until the next rebuild.
      ctx.logger.warn('budget.release_failed', { request_id: reservation.requestId }, error);
    }
    ctx.logger.info('budget.reservation_abandoned', { request_id: reservation.requestId });
  }
  return settled;
}

/** Rewrites every current counter, and those of live reservations, from Postgres. */
export async function rebuildBudgetCounters(
  ctx: BudgetEngineContext,
  now: Date = new Date(),
): Promise<number> {
  const prefix = ctx.keyPrefix ?? DEFAULT_KEY_PREFIX;
  // Taken before reading, so any reservation that begins after the read is newer than it.
  const cutoff = uuidv7Floor(Date.now() - REBUILD_SKEW_MS);
  const targets = await listRebuildTargets(ctx.db);
  const periodOf = new Map(targets.budgets.map((b) => [b.budgetId, b.period]));
  const lines = new Map<string, ReservationLineRow & { period: BudgetPeriod }>();
  const add = (budgetId: string, start: Date) => {
    const period = periodOf.get(budgetId);
    if (period !== undefined) {
      lines.set(counterKey(prefix, budgetId, start), { budgetId, periodStart: start, period });
    }
  };
  for (const b of targets.budgets) add(b.budgetId, periodStart(b.period, now));
  for (const l of targets.liveLines) add(l.budgetId, l.periodStart);
  const all = [...lines.values()];
  const seeds = await loadCounterSeeds(ctx.db, all, ['pending', 'active']);
  for (const [i, seed] of seeds.entries()) {
    // loadCounterSeeds returns one seed per line, in order.
    const line = all[i] as (typeof all)[number];
    await ctx.cache.runScript(
      REBUILD,
      [counterKey(prefix, seed.budgetId, seed.periodStart)],
      [
        String(counterExpiry(line)),
        String(seed.spentMicroUsd),
        cutoff,
        ...seed.holds.flatMap((h) => [h.reservationId, String(h.amountMicroUsd)]),
      ],
    );
  }
  return seeds.length;
}

export interface MaintenanceOptions {
  /** How often the sweep runs; the spec's 30 seconds by default. */
  intervalMs?: number;
  /** Every this many sweeps, counters are rebuilt too. */
  rebuildEvery?: number;
  /** Where recorded threshold alerts are queued for delivery (BG-10); none leaves them pending. */
  alerts?: AlertSender;
}

/**
 * Runs the sweep on an interval, and the rebuild every few sweeps, in at most one process at a
 * time (a Postgres advisory lock). Rebuilds once at start. Returns a function that stops it.
 */
export function startBudgetMaintenance(
  ctx: BudgetEngineContext,
  pool: Pool,
  options: MaintenanceOptions = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 30_000;
  const rebuildEvery = options.rebuildEvery ?? 10;
  let ticks = 0;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    const rebuild = ticks % rebuildEvery === 0;
    ticks += 1;
    running = withAdvisoryLock(pool, MAINTENANCE_LOCK_KEY, async () => {
      const count = await sweepExpiredReservations(ctx);
      if (count > 0) ctx.logger.info('budget.sweep_finished', { count });
      if (rebuild) await rebuildBudgetCounters(ctx);
      if (options.alerts !== undefined) await enqueuePendingAlerts(ctx, options.alerts);
    })
      .then(() => undefined)
      .catch((error: unknown) => ctx.logger.error('budget.maintenance_failed', {}, error));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
