import {
  BudgetExceededError,
  BudgetUnavailableError,
  LakkaError,
  periodEnd,
  periodStart,
} from '@lakka/contracts';
import type { BudgetPeriod, BudgetScope, Principal } from '@lakka/contracts';
import {
  chargeReservation,
  insertReservation,
  loadCounterSeeds,
  transitionReservation,
  uuidv7,
} from '@lakka/db';
import type { Db } from '@lakka/db';
import { cacheScript } from '../cache.ts';
import type { CacheClient } from '../cache.ts';
import type { Logger } from '../logger.ts';
import type { PolicySnapshot } from '../routing/score.ts';

/*
 * The reservation engine (BG-3, BG-4, BG-5, invariant 4, invariant 5, ADR 0050).
 *
 * Each cap has one Valkey hash per period: field `spent`, plus one field `r:<reservation id>`
 * per hold. What is in use is spent plus the sum of the holds. Keeping each hold as its own
 * field, rather than one running total, makes every step safe to repeat and lets a counter be
 * rebuilt exactly from Postgres.
 *
 * Reserve: write the reservation row ('pending'), then one Lua script checks every cap and adds
 * the hold to all of them or to none, then the row becomes 'active'. A counter missing from
 * Valkey (a new period, or after a flush) is rebuilt from Postgres first: spend for the period,
 * plus the active reservations holding against it.
 *
 * Settle: charge the actual cost to Postgres (the truth) and mark the row settled, in one
 * transaction; then remove the hold in Valkey and add the cost to `spent`, but only where the
 * hold was still present. A missing hold means the counter was rebuilt after the charge was
 * committed, and already includes it.
 */

export interface BudgetEngineContext {
  db: Db;
  cache: CacheClient;
  logger: Logger;
  /** Prefix for counter keys; tests use their own so they never touch each other's counters. */
  keyPrefix?: string;
}

/** One cap a request is charged against, in the period it falls in. */
export interface ChargeLine {
  budgetId: string;
  scope: BudgetScope;
  limitMicroUsd: bigint;
  period: BudgetPeriod;
  periodStart: Date;
}

export interface Reservation {
  id: string;
  requestId: string;
  amountMicroUsd: bigint;
  lines: readonly ChargeLine[];
  expiresAt: Date;
}

export interface SettleResult {
  /** False when the reservation had already been settled; nothing was charged twice. */
  settled: boolean;
  actualMicroUsd: bigint;
  /** How far the actual cost went past the reservation, or zero. */
  overageMicroUsd: bigint;
}

export const DEFAULT_KEY_PREFIX = 'budget:';
/** How long a hold lasts if its request never settles it; the sweep releases it after that. */
export const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
/** Counters outlive their period by two days, then Valkey drops them; Postgres keeps the spend. */
const COUNTER_GRACE_MS = 2 * 24 * 60 * 60 * 1000;
const SCOPE_ORDER: readonly BudgetScope[] = ['instance', 'workspace', 'member', 'key'];

/** Every cap that applies to `principal` in the snapshot's workspace, outermost first. */
export function chargeLines(policy: PolicySnapshot, principal: Principal, now: Date): ChargeLine[] {
  return policy.budgets
    .filter(
      (b) =>
        b.scope === 'instance' ||
        b.scope === 'workspace' ||
        (b.scope === 'member' && b.principalId === principal.actingUserId) ||
        (b.scope === 'key' && principal.kind === 'key' && b.principalId === principal.id),
    )
    .toSorted((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope))
    .map((b) => ({
      budgetId: b.id,
      scope: b.scope,
      limitMicroUsd: b.limitMicroUsd,
      period: b.period,
      periodStart: periodStart(b.period, now),
    }));
}

/** The Valkey key holding one cap's counter for one period. */
export function counterKey(prefix: string, budgetId: string, start: Date): string {
  return `${prefix}${budgetId}:${start.getTime()}`;
}

/** When Valkey may drop a counter: two days after its period ends, or never. */
export function counterExpiry(line: { period: BudgetPeriod; periodStart: Date }): number {
  const end = periodEnd(line.period, line.periodStart);
  return end === null ? 0 : end.getTime() + COUNTER_GRACE_MS;
}

/*
 * KEYS: one counter per cap, outermost first.
 * ARGV: amount, reservation id, then for each key its limit and expiry (ms, 0 for none).
 * Returns {'granted'}, {'missing', i...} for counters that must be rebuilt first, or
 * {'denied', i, remaining} naming the innermost cap that refused and the least headroom left.
 * Amounts stay below 2^53, where Lua's doubles are exact (MAX_BUDGET_MICRO_USD).
 */
const RESERVE = cacheScript(`
local amount = tonumber(ARGV[1])
local field = 'r:' .. ARGV[2]
local missing = {}
for i, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 0 then table.insert(missing, i) end
end
if #missing > 0 then
  local reply = {'missing'}
  for _, i in ipairs(missing) do table.insert(reply, i) end
  return reply
end
local denied = 0
local tightest = nil
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[1 + 2 * i])
  local values = redis.call('HGETALL', key)
  local used = 0
  for j = 1, #values, 2 do
    local name = values[j]
    -- A retried reserve does not count its own hold against itself.
    if name ~= field and (name == 'spent' or string.sub(name, 1, 2) == 'r:') then
      used = used + tonumber(values[j + 1])
    end
  end
  local left = limit - used
  if tightest == nil or left < tightest then tightest = left end
  if used + amount > limit then denied = i end
end
if denied > 0 then
  if tightest < 0 then tightest = 0 end
  return {'denied', denied, tightest}
end
for i, key in ipairs(KEYS) do
  redis.call('HSET', key, field, ARGV[1])
  local expiry = tonumber(ARGV[2 + 2 * i])
  if expiry > 0 then redis.call('PEXPIREAT', key, expiry) end
end
return {'granted'}
`);

/*
 * KEYS: one counter. ARGV: expiry, spent, then pairs of reservation id and amount.
 * Writes the counter only if it is still missing, so a rebuild never overwrites live counts.
 */
const SEED = cacheScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'spent', ARGV[2])
for j = 3, #ARGV, 2 do
  redis.call('HSET', KEYS[1], 'r:' .. ARGV[j], ARGV[j + 1])
end
local expiry = tonumber(ARGV[1])
if expiry > 0 then redis.call('PEXPIREAT', KEYS[1], expiry) end
return 1
`);

/*
 * KEYS: the reservation's counters. ARGV: reservation id, actual cost.
 * Where the hold is still present, removes it and adds the cost to spent.
 */
export const RELEASE = cacheScript(`
local field = 'r:' .. ARGV[1]
for _, key in ipairs(KEYS) do
  if redis.call('HDEL', key, field) == 1 then
    redis.call('HINCRBY', key, 'spent', ARGV[2])
  end
end
return 1
`);

const unavailable = (cause: unknown) =>
  new BudgetUnavailableError('budgets cannot be checked right now', { cause });

async function seedCounters(
  ctx: BudgetEngineContext,
  prefix: string,
  lines: readonly ChargeLine[],
): Promise<void> {
  const seeds = await loadCounterSeeds(ctx.db, lines);
  for (const [i, seed] of seeds.entries()) {
    // loadCounterSeeds returns one seed per line, in order.
    const line = lines[i] as ChargeLine;
    await ctx.cache.runScript(
      SEED,
      [counterKey(prefix, seed.budgetId, seed.periodStart)],
      [
        String(counterExpiry(line)),
        String(seed.spentMicroUsd),
        ...seed.holds.flatMap((h) => [h.reservationId, String(h.amountMicroUsd)]),
      ],
    );
  }
  ctx.logger.info('budget.counters_rebuilt', { count: seeds.length });
}

type ReserveReply = { kind: 'granted' } | { kind: 'denied'; line: ChargeLine; remaining: bigint };

async function holdInValkey(
  ctx: BudgetEngineContext,
  prefix: string,
  id: string,
  lines: readonly ChargeLine[],
  amount: bigint,
): Promise<ReserveReply> {
  const keys = lines.map((l) => counterKey(prefix, l.budgetId, l.periodStart));
  const args = [
    String(amount),
    id,
    ...lines.flatMap((l) => [String(l.limitMicroUsd), String(counterExpiry(l))]),
  ];
  // A rebuild can race a flush or a new period starting; a couple of rounds settles it.
  for (let round = 0; round < 3; round += 1) {
    const reply = (await ctx.cache.runScript(RESERVE, keys, args)) as unknown[];
    const [kind, ...rest] = reply;
    if (kind === 'granted') return { kind: 'granted' };
    if (kind === 'denied') {
      const line = lines[Number(rest[0]) - 1];
      if (line === undefined) throw new Error('reserve script named no cap');
      return { kind: 'denied', line, remaining: BigInt(Math.trunc(Number(rest[1]))) };
    }
    if (kind !== 'missing') throw new Error('unexpected reply from the reserve script');
    await seedCounters(
      ctx,
      prefix,
      rest.flatMap((i) => {
        const line = lines[Number(i) - 1];
        return line === undefined ? [] : [line];
      }),
    );
  }
  throw new Error('budget counters could not be rebuilt');
}

/**
 * Holds `amountMicroUsd` against every line, or none. Throws BudgetExceededError naming the scope
 * that refused, or BudgetUnavailableError when Postgres or Valkey cannot be reached.
 */
export async function reserveBudget(
  ctx: BudgetEngineContext,
  request: ReserveRequest,
): Promise<Reservation> {
  const now = request.now ?? new Date();
  const reservation: Reservation = {
    id: uuidv7(),
    requestId: request.requestId,
    amountMicroUsd: request.amountMicroUsd,
    lines: request.lines,
    expiresAt: new Date(now.getTime() + (request.ttlMs ?? DEFAULT_RESERVATION_TTL_MS)),
  };
  if (request.lines.length === 0) return reservation;
  const prefix = ctx.keyPrefix ?? DEFAULT_KEY_PREFIX;

  try {
    await insertReservation(ctx.db, {
      id: reservation.id,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      principalId: request.principal.id,
      actingUserId: request.principal.actingUserId,
      amountMicroUsd: request.amountMicroUsd,
      expiresAt: reservation.expiresAt,
      lines: request.lines.map((l) => ({ budgetId: l.budgetId, periodStart: l.periodStart })),
    });
  } catch (error) {
    throw unavailable(error);
  }

  let reply: ReserveReply;
  try {
    reply = await holdInValkey(ctx, prefix, reservation.id, request.lines, request.amountMicroUsd);
  } catch (error) {
    await markDenied(ctx, reservation.id);
    throw error instanceof LakkaError ? error : unavailable(error);
  }
  if (reply.kind === 'denied') {
    await markDenied(ctx, reservation.id);
    throw new BudgetExceededError(`the ${reply.line.scope} budget does not have room`, {
      scope: reply.line.scope,
      remainingMicroUsd: reply.remaining,
      requiredMicroUsd: request.amountMicroUsd,
    });
  }

  try {
    await transitionReservation(ctx.db, reservation.id, ['pending'], 'active');
  } catch (error) {
    // Postgres went away between the two steps. Release the hold and refuse: a hold with no
    // active row could not be rebuilt, and serving the request would be unmetered.
    await ctx.cache
      .runScript(RELEASE, keysOf(prefix, request.lines), [reservation.id, '0'])
      .catch(() => undefined);
    throw unavailable(error);
  }
  return reservation;
}

async function markDenied(ctx: BudgetEngineContext, id: string): Promise<void> {
  try {
    await transitionReservation(ctx.db, id, ['pending'], 'denied');
  } catch (error) {
    // The row stays pending. The periodic rebuild counts pending holds, so until the sweep closes
    // it after its expiry it can only make the caps stricter, never looser.
    ctx.logger.warn('budget.deny_record_failed', {}, error);
  }
}

function keysOf(prefix: string, lines: readonly ChargeLine[]): string[] {
  return lines.map((l) => counterKey(prefix, l.budgetId, l.periodStart));
}

export interface ReserveRequest {
  requestId: string;
  workspaceId: string;
  principal: Principal;
  lines: readonly ChargeLine[];
  amountMicroUsd: bigint;
  /** How long the hold lasts if the request never settles it. */
  ttlMs?: number;
  now?: Date;
}

/**
 * Charges `actualMicroUsd` to the period each line was reserved in, and releases the hold. Safe
 * to call more than once. Throws BudgetUnavailableError if Postgres cannot be reached; the
 * reservation then stays active until the sweep settles it.
 */
export async function settleReservation(
  ctx: BudgetEngineContext,
  reservation: Reservation,
  actualMicroUsd: bigint,
): Promise<SettleResult> {
  const overageMicroUsd =
    actualMicroUsd > reservation.amountMicroUsd ? actualMicroUsd - reservation.amountMicroUsd : 0n;
  if (reservation.lines.length === 0) {
    return { settled: true, actualMicroUsd, overageMicroUsd };
  }
  let charged: boolean;
  try {
    charged = await chargeReservation(ctx.db, reservation.id, actualMicroUsd, 'settled');
  } catch (error) {
    throw unavailable(error);
  }
  if (!charged) return { settled: false, actualMicroUsd, overageMicroUsd: 0n };

  const prefix = ctx.keyPrefix ?? DEFAULT_KEY_PREFIX;
  try {
    await ctx.cache.runScript(RELEASE, keysOf(prefix, reservation.lines), [
      reservation.id,
      String(actualMicroUsd),
    ]);
  } catch (error) {
    // Postgres has the charge. The stale hold in Valkey only makes caps stricter until the
    // counter is next rebuilt.
    ctx.logger.warn('budget.release_failed', { request_id: reservation.requestId }, error);
  }
  if (overageMicroUsd > 0n) {
    // Allowed, since the work is done, but a sign the estimate is wrong if it keeps happening.
    ctx.logger.warn('budget.overage', {
      request_id: reservation.requestId,
      overage_micro_usd: String(overageMicroUsd),
    });
  }
  return { settled: true, actualMicroUsd, overageMicroUsd };
}
