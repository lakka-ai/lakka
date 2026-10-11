import { describe, expect, it } from 'vitest';
import { HealthCheckFailure } from '@lakka/core';
import { liveApiClassifierCheck } from '../src/health.ts';

/*
 * The operator diagnostics command asks the running api how the classifier is, instead of
 * loading its own copy of the model (AD-3, ADR 0083). No network: fetch is replaced.
 */

const URL = 'http://127.0.0.1:3000/healthz';

const answering = (body: unknown, status = 200): typeof fetch =>
  (async () => Response.json(body, { status })) as typeof fetch;

async function failure(check: () => Promise<void>): Promise<string | undefined> {
  try {
    await check();
    return undefined;
  } catch (error) {
    return error instanceof HealthCheckFailure ? error.code : 'not a health failure';
  }
}

describe('the operator command checks the classifier through the api (AD-3)', () => {
  it('AD-3: passes when the api reports the classifier up, degraded or not', async () => {
    const report = {
      status: 'degraded',
      checks: {
        database: { status: 'ok', latency_ms: 1 },
        classifier: { status: 'ok', latency_ms: 3 },
        'provider:openai': { status: 'down', latency_ms: 2, error_code: 'auth_failed' },
      },
    };
    expect(await failure(liveApiClassifierCheck(URL, answering(report)))).toBeUndefined();
  });

  it("AD-3: reports the api's reason when the classifier is down", async () => {
    const report = {
      status: 'degraded',
      checks: { classifier: { status: 'down', latency_ms: 5, error_code: 'unavailable' } },
    };
    expect(await failure(liveApiClassifierCheck(URL, answering(report)))).toBe('unavailable');
  });

  it('AD-3: says the classifier is unreachable when the api does not answer', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await failure(liveApiClassifierCheck(URL, refused))).toBe('unreachable');
  });

  it('AD-3: an answer that is not a health report says unreachable, not ok', async () => {
    expect(await failure(liveApiClassifierCheck(URL, answering({ nope: true })))).toBe(
      'unreachable',
    );
    const withoutClassifier = {
      status: 'down',
      checks: { database: { status: 'down', latency_ms: 1 } },
    };
    expect(await failure(liveApiClassifierCheck(URL, answering(withoutClassifier, 503)))).toBe(
      'unreachable',
    );
  });
});
