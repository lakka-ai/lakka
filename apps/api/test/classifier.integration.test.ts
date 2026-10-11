import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelView, RouteView, TryPhraseResult, WorkspaceView } from '@lakka/contracts';
import type { ClassifierRuntime, Embedder } from '@lakka/core';
import { fakeEmbedder } from '../../../test/integration/fake-embedder.ts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Compiling routing policy and scoring phrases (RT-2, RT-4, invariant 10, ADR 0043) against real
 * Postgres with pgvector, with a deterministic fake embedder standing in for the ONNX model.
 */

let t: TestApp;
let admin: SignedInUser;
let ws: WorkspaceView;
let model: string;
let embedder: Embedder | undefined = fakeEmbedder('fake-embedder@1');
const phrases: string[] = [];

// A runtime whose model the test can swap or take away.
const classifier: ClassifierRuntime = {
  status: () => (embedder === undefined ? 'unavailable' : 'ready'),
  embedder: () => Promise.resolve(embedder),
};

const tryPhrase = async (text: string) => {
  phrases.push(text);
  return (
    await as(t, admin).post(`/api/workspaces/${ws.id}/routing/try`, { text })
  ).json() as TryPhraseResult;
};

async function addRoute(name: string, examples: string[]): Promise<RouteView> {
  const res = await as(t, admin).post(`/api/workspaces/${ws.id}/routes`, { name, model, examples });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { route: RouteView }).route;
}

async function describedRoute(name: string, description: string): Promise<RouteView> {
  const res = await as(t, admin).post(`/api/workspaces/${ws.id}/routes`, {
    name,
    description,
    model,
    examples: [],
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { route: RouteView }).route;
}
const centroidOf = async (routeId: string) =>
  (
    await t.pool.query<{ source: string; count: number; model: string }>(
      'select source, example_count as count, embedding_model as model from route_centroids where route_id = $1',
      [routeId],
    )
  ).rows[0];
const storedCentroid = async (routeId: string) => {
  const row = (
    await t.pool.query<{ embedding: string }>(
      'select embedding::text as embedding from route_centroids where route_id = $1',
      [routeId],
    )
  ).rows[0];
  return row === undefined ? undefined : (JSON.parse(row.embedding) as number[]);
};

beforeAll(async () => {
  t = await createTestApp({ classifier });
  admin = await signedInUser(t, 'Admin');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  ws = (
    (await as(t, admin).post('/api/workspaces', { name: 'C', slug: `c-${Date.now()}` })).json() as {
      workspace: WorkspaceView;
    }
  ).workspace;
  await as(t, admin).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  model = (
    (
      await as(t, admin).post('/api/models/custom', {
        provider: 'fake',
        model: 'm',
        contextWindow: 1000,
        maxOutputTokens: 100,
        capabilities: {
          vision: false,
          pdf: false,
          tools: false,
          structuredOutput: false,
          promptCaching: false,
          reasoning: false,
        },
        prices: {
          inputMicroUsdPerMtok: 1,
          outputMicroUsdPerMtok: 1,
          cacheReadMicroUsdPerMtok: null,
          cacheWriteMicroUsdPerMtok: null,
        },
      })
    ).json() as { model: ModelView }
  ).model.id;
});

afterAll(async () => {
  await t.close();
});

describe('compiling policy when it is saved', () => {
  it('RT-2: saving a route embeds its examples and stores a unit-length centroid', async () => {
    const code = await addRoute('code', [
      'fix this typescript compile error',
      'write a python function that parses csv',
      'refactor this javascript function',
    ]);
    expect(code.compiled).toMatchObject({
      model: 'fake-embedder@1',
      exampleCount: 3,
      source: 'examples',
    });
    const stored = await t.pool.query<{ norm: number; model: string }>(
      `select vector_norm(embedding) as norm, embedding_model as model from route_centroids where route_id = $1`,
      [code.id],
    );
    expect(stored.rows[0]?.model).toBe('fake-embedder@1');
    expect(stored.rows[0]?.norm).toBeCloseTo(1, 5);
    const examples = await t.pool.query(
      'select 1 from route_examples where route_id = $1 and embedding is not null',
      [code.id],
    );
    expect(examples.rowCount).toBe(3);
  });

  it('RT-4: a phrase is scored against the compiled routes, best match first', async () => {
    await addRoute('writing', [
      'draft a friendly email to a customer',
      'write a blog post about our launch',
      'proofread this letter',
    ]);
    const result = await tryPhrase('please fix the typescript error in this function');
    expect(result.status).toBe('scored');
    expect(result.scores.map((s) => s.route)).toEqual(['code', 'writing']);
    expect(result.scores[0]?.similarity).toBeGreaterThan(result.scores[1]?.similarity ?? 1);
    expect(
      (await tryPhrase('write an email to the customer about the launch')).scores[0]?.route,
    ).toBe('writing');
  });

  it('an edit takes effect on the next request: the cached policy reloads when its version moves', async () => {
    const policy = (await as(t, admin).get(`/api/workspaces/${ws.id}/routing`)).json() as {
      routes: RouteView[];
    };
    const writing = policy.routes.find((r) => r.name === 'writing');
    await as(t, admin).put(`/api/workspaces/${ws.id}/routes/${writing?.id}`, {
      name: 'writing',
      model,
      examples: ['fix this typescript compile error'],
    });
    const result = await tryPhrase('fix this typescript compile error please');
    expect(result.scores.find((s) => s.route === 'writing')?.similarity).toBeGreaterThan(0.9);
  });

  it('skips a phrase too short to carry a signal, and names routes that have nothing to learn from', async () => {
    await addRoute('empty', []);
    const result = await tryPhrase('shorter please');
    // No default model yet, so nothing would choose a model for it.
    expect(result).toEqual({
      status: 'too_short',
      scores: [],
      closestExamples: [],
      untrained: ['empty'],
      decision: null,
    });
  });

  it('RT-3, RT-6: a phrase shows what the resolution order would decide for a new conversation', async () => {
    await as(t, admin).put(`/api/workspaces/${ws.id}/routing/settings`, {
      routingEnabled: true,
      defaultModel: model,
      pinnedModel: null,
    });
    const code = await tryPhrase('refactor the javascript function for me');
    expect(code.decision).toMatchObject({ rule: 'classified', route: 'code', model });
    expect(code.decision?.confidence).toBe(code.scores[0]?.similarity);
    expect((await tryPhrase('shorter please')).decision).toEqual({
      rule: 'default',
      model,
      route: null,
      signal: null,
      confidence: null,
      reason: 'too_short',
      threshold: null,
    });
    expect((await tryPhrase('what is the capital of peru')).decision).toMatchObject({
      rule: 'default',
      reason: 'below_threshold',
    });
  });

  it('RT-5: says what the closest route needed, which routes that are off came close, and why', async () => {
    const result = await tryPhrase('refactor the javascript function for me');
    const route = (
      (await as(t, admin).get(`/api/workspaces/${ws.id}/routing`)).json() as { routes: RouteView[] }
    ).routes.find((r) => r.name === 'code');
    // The code route's model is the default itself, so it is not cheaper: the upward threshold.
    expect(result.decision?.threshold).toBe(route?.thresholdUp);
    expect(result.closestExamples).toHaveLength(2);
    expect(result.closestExamples[0]).toBe('refactor this javascript function');
    expect(result.scores.every((s) => s.enabled)).toBe(true);

    // A route switched off is still scored, marked, and never chosen.
    await as(t, admin).put(`/api/workspaces/${ws.id}/routes/${route?.id}`, {
      name: 'code',
      model,
      examples: route?.examples ?? [],
      enabled: false,
    });
    const off = await tryPhrase('refactor the javascript function for me');
    expect(off.scores[0]).toMatchObject({ route: 'code', enabled: false });
    expect(off.decision?.route).not.toBe('code');
    await as(t, admin).put(`/api/workspaces/${ws.id}/routes/${route?.id}`, {
      name: 'code',
      model,
      examples: route?.examples ?? [],
      enabled: true,
    });
  });

  it('NF-A3: after the embedding model changes, stale routes are recompiled before scoring', async () => {
    embedder = fakeEmbedder('fake-embedder@2');
    // The writing route now learns from a TypeScript phrase (previous test); this one is code's alone.
    const result = await tryPhrase('refactor the javascript function for me');
    expect(result.status).toBe('scored');
    expect(result.scores[0]?.route).toBe('code');
    const models = await t.pool.query<{ model: string }>(
      'select distinct embedding_model as model from route_centroids where workspace_id = $1',
      [ws.id],
    );
    expect(models.rows).toEqual([{ model: 'fake-embedder@2' }]);
  });

  it('invariant 10: without a classifier, saving still works and scoring says routing is unavailable', async () => {
    embedder = undefined;
    const route = await addRoute('later', ['summarize this long report']);
    expect(route.compiled).toBeNull();
    expect((await tryPhrase('summarize this quarterly report for me')).status).toBe(
      'classifier_unavailable',
    );
    embedder = fakeEmbedder('fake-embedder@2');
  });

  it('RT-12: a route with no examples compiles a centroid from its name and description', async () => {
    const legal = await describedRoute('legal', 'contracts indemnification clauses and nda review');
    expect(legal.compiled).toMatchObject({ exampleCount: 0, source: 'description' });
    expect(await centroidOf(legal.id)).toEqual({
      source: 'description',
      count: 0,
      model: 'fake-embedder@2',
    });
    const result = await tryPhrase('review this nda and its indemnification clauses');
    expect(result.scores[0]).toMatchObject({ route: 'legal', source: 'description' });
    expect(result.scores.find((x) => x.route === 'code')?.source).toBe('examples');
    // Described routes have something to learn from; only a route with neither is untrained.
    expect(result.untrained).toEqual(['empty']);
  });

  // ADR 0122 had the first example replace the description; ADR 0125 keeps the description as
  // one of the examples instead.
  it('RT-12: the first example joins the description in the centroid', async () => {
    const policy = (await as(t, admin).get(`/api/workspaces/${ws.id}/routing`)).json() as {
      routes: RouteView[];
    };
    const legal = policy.routes.find((r) => r.name === 'legal');
    const description = 'contracts indemnification clauses and nda review';
    const example = 'is this non compete clause enforceable';
    await as(t, admin).put(`/api/workspaces/${ws.id}/routes/${legal?.id}`, {
      name: 'legal',
      description,
      model,
      examples: [example],
    });
    expect(await centroidOf(legal?.id ?? '')).toEqual({
      source: 'examples_and_description',
      count: 1,
      model: 'fake-embedder@2',
    });
    // The mean of the example and `legal: <description>`, each with the same weight.
    const fake = fakeEmbedder('fake-embedder@2');
    const a = await fake.embed(example);
    const b = await fake.embed(`legal: ${description}`);
    const sum = Array.from(a, (x, i) => x + (b[i] ?? 0));
    const norm = Math.hypot(...sum);
    const stored = await storedCentroid(legal?.id ?? '');
    expect(stored).toHaveLength(sum.length);
    for (const [i, x] of sum.entries()) expect(stored?.[i]).toBeCloseTo(x / norm, 5);
    const after = (await as(t, admin).get(`/api/workspaces/${ws.id}/routing`)).json() as {
      routes: RouteView[];
    };
    expect(after.routes.find((r) => r.name === 'legal')?.compiled).toMatchObject({
      exampleCount: 1,
      source: 'examples_and_description',
    });
    const result = await tryPhrase('is this indemnification clause in the nda enforceable');
    expect(result.scores.find((x) => x.route === 'legal')?.source).toBe('examples_and_description');
  });

  it("RT-12: clearing a trained route's description compiles its examples alone", async () => {
    const policy = (await as(t, admin).get(`/api/workspaces/${ws.id}/routing`)).json() as {
      routes: RouteView[];
    };
    const legal = policy.routes.find((r) => r.name === 'legal');
    await as(t, admin).put(`/api/workspaces/${ws.id}/routes/${legal?.id}`, {
      name: 'legal',
      description: '',
      model,
      examples: ['is this non compete clause enforceable'],
    });
    expect(await centroidOf(legal?.id ?? '')).toEqual({
      source: 'examples',
      count: 1,
      model: 'fake-embedder@2',
    });
    const example = await fakeEmbedder('fake-embedder@2').embed(
      'is this non compete clause enforceable',
    );
    const stored = await storedCentroid(legal?.id ?? '');
    for (const [i, x] of example.entries()) expect(stored?.[i]).toBeCloseTo(x, 5);
  });

  it('RT-12: a trained route compiled before ADR 0125 recompiles with its description before Try a phrase scores it', async () => {
    const route = await addRoute('finance', ['reconcile the ledger for march']);
    await as(t, admin).put(`/api/workspaces/${ws.id}/routes/${route.id}`, {
      name: 'finance',
      description: 'ledgers budgets and forecasts',
      model,
      examples: ['reconcile the ledger for march'],
    });
    expect((await centroidOf(route.id))?.source).toBe('examples_and_description');
    // What an earlier version left behind: the same route compiled from its examples alone.
    await t.pool.query("update route_centroids set source = 'examples' where route_id = $1", [
      route.id,
    ]);
    await t.pool.query('update workspaces set policy_version = policy_version + 1 where id = $1', [
      ws.id,
    ]);
    const result = await tryPhrase('reconcile the march ledger against the forecasts');
    expect(result.scores.find((x) => x.route === 'finance')?.source).toBe(
      'examples_and_description',
    );
    expect((await centroidOf(route.id))?.source).toBe('examples_and_description');
  });

  it('RT-12: after the embedding model changes, description centroids are recompiled too', async () => {
    const tax = await describedRoute('tax', 'vat invoices and tax returns');
    embedder = fakeEmbedder('fake-embedder@3');
    expect((await tryPhrase('prepare the vat invoices and tax returns')).scores[0]?.route).toBe(
      'tax',
    );
    expect(await centroidOf(tax.id)).toEqual({
      source: 'description',
      count: 0,
      model: 'fake-embedder@3',
    });
  });

  it('NF-S5: phrases and examples never reach the logs', () => {
    const logs = t.logs.join('\n');
    expect(logs).toContain('"msg":"routing.policy_compiled"');
    for (const text of [...phrases, 'draft a friendly email', 'vat invoices and tax returns'])
      expect(logs).not.toContain(text);
  });
});
