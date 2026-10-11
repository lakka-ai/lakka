import { cacheScript } from '../cache.ts';
import type { CacheClient } from '../cache.ts';

/*
 * Fixed-window rate limit counter in Valkey, for Better Auth's sign-in throttling. Rate limits
 * belong in Valkey (CLAUDE.md, Stack), and the check and the increment happen in one script so
 * concurrent attempts cannot all slip past a stale read. If Valkey is unreachable the call
 * throws and the auth request fails: throttling fails closed.
 */

const CONSUME = cacheScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
if count > tonumber(ARGV[2]) then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
    ttl = tonumber(ARGV[1])
  end
  return {0, ttl}
end
return {1, 0}
`);

export const AUTH_RATE_LIMIT_PREFIX = 'lakka:auth-rate:';

export interface RateLimitStorage {
  consume(
    key: string,
    rule: { window: number; max: number },
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
}

export function valkeyRateLimitStorage(cache: CacheClient): RateLimitStorage {
  return {
    async consume(key, rule) {
      const result = await cache.runScript(
        CONSUME,
        [`${AUTH_RATE_LIMIT_PREFIX}${key}`],
        [String(Math.max(1, Math.ceil(rule.window))), String(rule.max)],
      );
      if (!Array.isArray(result) || result.length !== 2) {
        throw new Error('unexpected rate limit script result');
      }
      const [allowed, ttl] = result.map(Number);
      return allowed === 1
        ? { allowed: true, retryAfter: null }
        : { allowed: false, retryAfter: Math.max(1, ttl ?? rule.window) };
    },
  };
}
