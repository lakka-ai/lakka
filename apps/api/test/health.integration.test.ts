import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthReport } from '@lakka/contracts';
import type { HealthReport, WorkspaceView } from '@lakka/contracts';
import { createLogger, lazyClassifierRuntime } from '@lakka/core';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * /healthz as the api wires it (AD-5, NF-O4, ADR 0017, ADR 0081), against real Postgres and
 * Valkey: the database and cache are required, while the classifier and each instance provider
 * only degrade it, so an operator can tell a provider outage from a database problem.
 */

let fake: FakeProvider;
let t: TestApp;
let root: SignedInUser;

/** A classifier that loads, standing in for the model the image bakes in. */
function stubClassifier() {
  return lazyClassifierRuntime({
    load: async () => ({
      modelId: 'stub@1',
      dimensions: 1,
      embed: () => Promise.resolve(Float32Array.from([1])),
    }),
    logger: createLogger({ level: 'silent', service: 'test' }).logger,
  });
}

async function health(app: TestApp): Promise<{ statusCode: number; report: HealthReport }> {
  const res = await app.app.inject({ method: 'GET', url: '/healthz' });
  return { statusCode: res.statusCode, report: healthReport.parse(res.json()) };
}

beforeAll(async () => {
  fake = await startFakeProvider();
  t = await createTestApp({ classifier: stubClassifier() });
  root = await signedInUser(t, 'Root');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  const created = await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  if (created.statusCode !== 201) throw new Error(`provider not added: ${created.statusCode}`);
});

afterAll(async () => {
  await fake?.close();
  await t?.close();
});

describe('/healthz (AD-5)', () => {
  it('AD-5: reports database, cache, classifier and each provider separately, ok overall', async () => {
    const { statusCode, report } = await health(t);
    expect(statusCode).toBe(200);
    expect(report.status).toBe('ok');
    expect(Object.keys(report.checks).toSorted()).toEqual([
      'cache',
      'classifier',
      'database',
      'provider:fake',
    ]);
    expect(Object.values(report.checks).every((c) => c.status === 'ok')).toBe(true);
  });

  it('NF-O4: a provider that cannot be reached degrades the api, answers 200, and says which', async () => {
    const res = await as(t, root).post('/api/providers', {
      kind: 'openai-compatible',
      name: 'nowhere',
      // Nothing listens on port 1.
      baseUrl: 'http://127.0.0.1:1/v1',
    });
    try {
      const { statusCode, report } = await health(t);
      expect(statusCode).toBe(200);
      expect(report.status).toBe('degraded');
      expect(report.checks['provider:nowhere']).toMatchObject({
        status: 'down',
        error_code: 'unreachable',
      });
      expect(report.checks['provider:fake']?.status).toBe('ok');
      expect(report.checks['database']?.status).toBe('ok');
      expect(JSON.stringify(report)).not.toContain('127.0.0.1');
    } finally {
      await as(t, root).delete(
        `/api/providers/${(res.json() as { provider: { id: string } }).provider.id}`,
      );
    }
    expect((await health(t)).report.status).toBe('ok');
  });

  it("AD-5: a workspace's own credentials are not reported on the unauthenticated endpoint", async () => {
    const ws = (
      (
        await as(t, root).post('/api/workspaces', {
          name: 'Own keys',
          slug: `own-${randomBytes(3).toString('hex')}`,
        })
      ).json() as { workspace: WorkspaceView }
    ).workspace;
    const res = await as(t, root).post(`/api/workspaces/${ws.id}/providers`, {
      kind: 'openai',
      apiKey: 'sk-workspace-only',
    });
    expect(res.statusCode).toBe(201);
    const { report } = await health(t);
    expect(Object.keys(report.checks)).not.toContain('provider:openai');
  });

  it('NF-O4: without a classifier, routing is reported unavailable and the api is degraded, not down', async () => {
    const plain = await createTestApp();
    try {
      const { statusCode, report } = await health(plain);
      expect(statusCode).toBe(200);
      expect(report).toMatchObject({
        status: 'degraded',
        checks: {
          database: { status: 'ok' },
          cache: { status: 'ok' },
          classifier: { status: 'down', error_code: 'unavailable' },
        },
      });
    } finally {
      await plain.close();
    }
  });

  it('AD-5, NF-O4: with Postgres unreachable, answers 503 with the database down and the cache up', async () => {
    const down = await createTestApp({ unreachableDatabase: true, revocationEvents: false });
    try {
      const started = Date.now();
      const { statusCode, report } = await health(down);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(statusCode).toBe(503);
      expect(report.status).toBe('down');
      expect(report.checks['database']).toMatchObject({ status: 'down' });
      expect(report.checks['cache']?.status).toBe('ok');
    } finally {
      await down.close();
    }
  });
});
