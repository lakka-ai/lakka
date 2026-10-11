import { BudgetUnavailableError, LakkaError, RateLimitedError } from '@lakka/contracts';
import { cacheScript } from '../cache.ts';
import type { CacheClient } from '../cache.ts';

/*
 * The per-person rate limit on model requests (BG-12, ADR 0113). One token bucket per person,
 * instance-wide, keyed by the acting person, so a key draws on its owner's bucket and can never
 * start more than its owner could (invariant 2). Each model request takes one token; tokens come
 * back at the configured rate, up to the burst.
 *
 * Valkey holds the bucket and reads its own clock, so every api process agrees on it. A missing
 * key is a full bucket: the key expires once the bucket would be full again, and a flush only
 * gives people their full burst back, never anything that must be rebuilt (invariant 5). If
 * Valkey cannot be reached the request is refused with budget_unavailable, exactly as budgets
 * are (invariant 3, ADR 0056).
 */

export interface ModelRateLimit {
  /** Model requests one person may start per minute, on average. 0 turns the limit off. */
  perMinute: number;
  /** How many they may start at once, from a full bucket, before the rate applies. */
  burst: number;
  /** Prefix for bucket keys; tests use their own so they never touch each other's buckets. */
  keyPrefix?: string;
}

export const MODEL_RATE_LIMIT_PREFIX = 'lakka:model-rate:';

/*
 * KEYS: the person's bucket. ARGV: capacity (the burst), tokens per minute.
 * Returns {1, 0} when a token was taken, or {0, ms} with how long until one is back.
 * The bucket is a hash of the tokens left (fractional) and when that was true (ms, Valkey's
 * clock). A refusal writes nothing: the stored state still refills from when it was written.
 */
const TAKE = cacheScript(`
local capacity = tonumber(ARGV[1])
local perMs = tonumber(ARGV[2]) / 60000
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil or at == nil then
  tokens = capacity
else
  tokens = math.min(capacity, tokens + math.max(0, now - at) * perMs)
end
if tokens < 1 then
  return {0, math.max(1, math.ceil((1 - tokens) / perMs))}
end
tokens = tokens - 1
redis.call('HSET', KEYS[1], 'tokens', string.format('%.6f', tokens), 'at', now)
redis.call('PEXPIRE', KEYS[1], math.max(1, math.ceil((capacity - tokens) / perMs)))
return {1, 0}
`);

export type RateDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Whether the limit is on: a rate of 0, or no limit at all, turns it off. */
export function rateLimitOn(limit: ModelRateLimit | undefined): limit is ModelRateLimit {
  return limit !== undefined && limit.perMinute > 0;
}

/**
 * Takes one token from the person's bucket. Throws BudgetUnavailableError when Valkey cannot be
 * reached, so a request is never started unchecked.
 */
export async function takeModelRequest(
  cache: CacheClient,
  limit: ModelRateLimit,
  personId: string,
): Promise<RateDecision> {
  let reply: unknown;
  try {
    reply = await cache.runScript(
      TAKE,
      [`${limit.keyPrefix ?? MODEL_RATE_LIMIT_PREFIX}${personId}`],
      [String(limit.burst), String(limit.perMinute)],
    );
  } catch (error) {
    if (error instanceof LakkaError) throw error;
    throw new BudgetUnavailableError('request limits cannot be checked right now', {
      cause: error,
    });
  }
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error('unexpected reply from the rate limit script');
  }
  const [allowed, wait] = reply.map(Number);
  return allowed === 1
    ? { allowed: true }
    : { allowed: false, retryAfterMs: Math.max(1, wait ?? 1) };
}

/** The refusal, with how long to wait in whole seconds, at least one (Retry-After). */
export function rateLimitedError(retryAfterMs: number): RateLimitedError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new RateLimitedError(
    `Too many requests. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
    seconds,
  );
}
