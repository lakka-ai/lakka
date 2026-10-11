import { describe, expect, it } from 'vitest';
import { classifierHealthCheck, lazyClassifierRuntime } from '../src/classifier/runtime.ts';
import { checkHealth } from '../src/health.ts';
import { createLogger } from '../src/logger.ts';
import { providerHealthChecks } from '../src/providers/health.ts';
import type { ProbedCredential } from '../src/providers/health.ts';

/*
 * The classifier and provider entries in /healthz (AD-5, NF-O4, ADR 0081), without a network:
 * providers are answered by a stub fetch.
 */

const { logger } = createLogger({ level: 'silent', service: 'test' });

function credential(name: string, version = '1', apiKey = 'sk-test'): ProbedCredential {
  return {
    name,
    version,
    connection: { kind: 'openai-compatible', name, baseURL: `http://${name}.test/v1`, apiKey },
  };
}

/** A fetch that answers each host with the status given, and counts the calls. */
function stubFetch(statusByHost: Record<string, number | 'refused'>) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.host);
    const status = statusByHost[url.host.replace(/\.test$/, '')] ?? 200;
    if (status === 'refused') throw new TypeError('fetch failed');
    return new Response('{}', { status });
  };
  return { calls, fetch: fetchImpl };
}

describe('provider health (AD-5, ADR 0081)', () => {
  it('NF-O4: reports each provider by name, with why it is down', async () => {
    const stub = stubFetch({ good: 200, revoked: 401, broken: 500, gone: 'refused' });
    const checks = providerHealthChecks({
      list: async () => ['good', 'revoked', 'broken', 'gone'].map((n) => credential(n)),
      timeoutMs: 100,
      fetch: stub.fetch,
    });
    const report = await checkHealth(
      { database: async () => undefined },
      { timeoutMs: 100, optional: checks },
    );
    expect(report.status).toBe('degraded');
    expect(report.checks).toMatchObject({
      'provider:good': { status: 'ok' },
      'provider:revoked': { status: 'down', error_code: 'auth_failed' },
      'provider:broken': { status: 'down', error_code: 'error' },
      'provider:gone': { status: 'down', error_code: 'unreachable' },
    });
  });

  it('AD-5: probes each provider at most once a minute, however often it is asked', async () => {
    let clock = 0;
    const stub = stubFetch({});
    let version = '1';
    const checks = providerHealthChecks({
      list: async () => [credential('good', version)],
      timeoutMs: 100,
      fetch: stub.fetch,
      now: () => clock,
    });
    const once = async () => {
      const listed = await checks();
      await Promise.all(Object.values(listed).map((check) => check()));
    };
    await Promise.all([once(), once(), once()]);
    expect(stub.calls).toHaveLength(1);
    clock = 59_000;
    await once();
    expect(stub.calls).toHaveLength(1);
    clock = 60_000;
    await once();
    expect(stub.calls).toHaveLength(2);
    // An edited credential is probed again at once.
    version = '2';
    await once();
    expect(stub.calls).toHaveLength(3);
  });

  it('AD-5: a provider removed from the instance is no longer reported', async () => {
    let names = ['one', 'two'];
    const checks = providerHealthChecks({
      list: async () => names.map((n) => credential(n)),
      timeoutMs: 100,
      fetch: stubFetch({}).fetch,
    });
    expect(Object.keys(await checks())).toEqual(['provider:one', 'provider:two']);
    names = ['two'];
    expect(Object.keys(await checks())).toEqual(['provider:two']);
  });
});

describe('classifier health (AD-5, ADR 0081)', () => {
  it('AD-5: loads the classifier and reports it ok', async () => {
    const runtime = lazyClassifierRuntime({
      load: async () => ({
        modelId: 'stub@1',
        dimensions: 1,
        embed: () => Promise.resolve(Float32Array.from([1])),
      }),
      logger,
    });
    await expect(classifierHealthCheck(runtime)()).resolves.toBeUndefined();
    expect(runtime.status()).toBe('ready');
  });

  it('NF-O4, invariant 10: a classifier that cannot load is down as unavailable, and only degrades', async () => {
    const runtime = lazyClassifierRuntime({
      load: () => Promise.reject(new Error('model missing')),
      logger,
    });
    const report = await checkHealth(
      { database: async () => undefined },
      { timeoutMs: 100, optional: async () => ({ classifier: classifierHealthCheck(runtime) }) },
    );
    expect(report).toMatchObject({
      status: 'degraded',
      checks: { classifier: { status: 'down', error_code: 'unavailable' } },
    });
  });
});
