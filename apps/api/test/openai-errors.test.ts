import { describe, expect, it } from 'vitest';
import * as contracts from '@lakka/contracts';
import {
  BudgetExceededError,
  LakkaError,
  ProviderAuthError,
  RateLimitedError,
  UpstreamUnavailableError,
} from '@lakka/contracts';
import { MAPPED_CODES, toOpenAiError } from '../src/openai/errors.ts';

/* Errors in the OpenAI shape (API-5, CH-7, ADR 0059). */

/**
 * Every code an exported LakkaError raises, found by constructing each class. The second
 * argument is the details a budget refusal takes; other classes read it as ErrorOptions without a
 * cause, which changes nothing.
 */
const PROBE_ARGS = ['probe', { scope: 'workspace', remainingMicroUsd: 0n }];

function raisedCodes(): Set<string> {
  const codes = new Set<string>();
  for (const value of Object.values(contracts)) {
    if (typeof value !== 'function' || !(value.prototype instanceof LakkaError)) continue;
    try {
      const error: unknown = Reflect.construct(value, PROBE_ARGS);
      if (error instanceof LakkaError) codes.add(error.code);
    } catch {
      // A constructor that needs something else; its codes then show up as unmatched below.
    }
  }
  return codes;
}

describe('the OpenAI error mapping', () => {
  it('API-5: every mapped code is one the product really raises', () => {
    const codes = raisedCodes();
    expect(MAPPED_CODES.filter((code) => !codes.has(code))).toEqual([]);
  });

  it('CH-7: a refused provider credential is a 502 for the admin to fix, not a 500', () => {
    expect(toOpenAiError(new ProviderAuthError('The provider refused the key.'))).toEqual({
      status: 502,
      body: {
        error: {
          message: 'The provider refused the key.',
          type: 'server_error',
          param: null,
          code: 'provider_auth_failed',
        },
      },
    });
  });

  it('CH-4: a budget refusal says which cap, what is left on it, and what the request needed', () => {
    const refused = new BudgetExceededError('the member budget does not have room', {
      scope: 'member',
      remainingMicroUsd: 400_000n,
      requiredMicroUsd: 1_400_000n,
    });
    expect(toOpenAiError(refused).body.lakka).toEqual({
      scope: 'member',
      remaining_micro_usd: '400000',
      required_micro_usd: '1400000',
    });
  });

  it('CH-7: a provider that did not answer is named, with how long its rate limit asked to wait', () => {
    const limited = new UpstreamUnavailableError('no attempt produced a first chunk', {
      provider: 'anthropic',
      rateLimited: true,
      retryAfterSeconds: 20,
    });
    expect(toOpenAiError(limited)).toMatchObject({
      status: 502,
      body: {
        error: { code: 'upstream_unavailable' },
        lakka: { provider: 'anthropic', rate_limited: true, retry_after_seconds: 20 },
      },
    });
    // Without a known provider there is nothing to add.
    expect(toOpenAiError(new UpstreamUnavailableError('down')).body.lakka).toBeUndefined();
  });

  it('BG-12: rate_limited is 429 with Retry-After and retry_after_seconds', () => {
    const limited = new RateLimitedError('Too many requests. Try again in 7 seconds.', 7);
    expect(toOpenAiError(limited)).toEqual({
      status: 429,
      headers: { 'retry-after': '7', 'retry-after-ms': '7000' },
      body: {
        error: {
          message: 'Too many requests. Try again in 7 seconds.',
          type: 'rate_limit_error',
          param: null,
          code: 'rate_limited',
        },
        lakka: { retry_after_seconds: 7 },
      },
    });
    // Nothing else asks a client to wait.
    expect(toOpenAiError(new ProviderAuthError('no')).headers).toBeUndefined();
  });
});
