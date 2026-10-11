import { describe, expect, it } from 'vitest';
import { healthReport } from '@lakka/contracts';
import { checkHealth, HealthCheckFailure } from '../src/health.ts';

describe('checkHealth', () => {
  it('AD-5: reports each dependency separately and ok overall when all pass', async () => {
    const report = await checkHealth(
      { database: async () => undefined, cache: async () => undefined },
      { timeoutMs: 100 },
    );
    expect(healthReport.parse(report)).toEqual(report);
    expect(report.status).toBe('ok');
    expect(report.checks['database']?.status).toBe('ok');
    expect(report.checks['cache']?.status).toBe('ok');
  });

  it('NF-O4: a failing dependency is down with a code, and the others stay ok', async () => {
    const report = await checkHealth(
      {
        database: async () => {
          throw new Error('connect ECONNREFUSED');
        },
        cache: async () => undefined,
      },
      { timeoutMs: 100 },
    );
    expect(report.status).toBe('down');
    expect(report.checks['database']).toMatchObject({ status: 'down', error_code: 'unreachable' });
    expect(report.checks['cache']?.status).toBe('ok');
  });

  it('AD-5: a hanging dependency times out instead of hanging the endpoint', async () => {
    const report = await checkHealth(
      { cache: () => new Promise(() => undefined) },
      { timeoutMs: 20 },
    );
    expect(report.checks['cache']).toMatchObject({ status: 'down', error_code: 'timeout' });
  });

  it('NF-O4, ADR 0017: an optional dependency down degrades the status instead', async () => {
    const report = await checkHealth(
      { database: async () => undefined },
      {
        timeoutMs: 100,
        optional: async () => ({
          classifier: async () => {
            throw new HealthCheckFailure('unavailable');
          },
          'provider:openai': async () => undefined,
        }),
      },
    );
    expect(healthReport.parse(report)).toEqual(report);
    expect(report.status).toBe('degraded');
    expect(report.checks['classifier']).toMatchObject({
      status: 'down',
      error_code: 'unavailable',
    });
    expect(report.checks['provider:openai']?.status).toBe('ok');
  });

  it('ADR 0017: a required dependency down is down, whatever the optional ones say', async () => {
    const report = await checkHealth(
      {
        cache: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
      { timeoutMs: 100, optional: async () => ({ classifier: async () => undefined }) },
    );
    expect(report.status).toBe('down');
  });

  it('AD-5: an optional listing that fails or hangs lists nothing and does not hang', async () => {
    const failing = await checkHealth(
      { database: async () => undefined },
      {
        timeoutMs: 20,
        optional: () => Promise.reject(new Error('database gone')),
      },
    );
    expect(failing).toMatchObject({ status: 'ok', checks: { database: { status: 'ok' } } });
    const hanging = await checkHealth(
      { database: async () => undefined },
      { timeoutMs: 20, optional: () => new Promise(() => undefined) },
    );
    expect(Object.keys(hanging.checks)).toEqual(['database']);
  });
});
