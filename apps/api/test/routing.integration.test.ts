import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody, DEFAULT_THRESHOLD_DOWN, DEFAULT_THRESHOLD_UP } from '@lakka/contracts';
import type {
  IssuedKey,
  ModelView,
  RouteView,
  RoutingPolicyView,
  WorkspaceView,
} from '@lakka/contracts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Routing policy administration (RT-1, RT-2, RT-11, AC 16, ADR 0042) against real Postgres with
 * pgvector. Nothing here calls a provider or the classifier.
 */

let t: TestApp;
let admin: SignedInUser; // instance admin
let alphaAdmin: SignedInUser;
let alphaMember: SignedInUser;
let bravoAdmin: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let small: string;
let large: string;

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;
const policyOf = async (user: SignedInUser, ws: WorkspaceView) =>
  (await as(t, user).get(`/api/workspaces/${ws.id}/routing`)).json() as RoutingPolicyView;

const route = (overrides: Record<string, unknown> = {}) => ({
  name: 'code',
  model: large,
  fallbacks: [],
  examples: ['Fix this TypeScript error', 'Write a SQL query that joins two tables'],
  ...overrides,
});

async function workspaceWithAdmin(name: string, wsAdmin: SignedInUser): Promise<WorkspaceView> {
  const ws = (
    (
      await as(t, admin).post('/api/workspaces', {
        name,
        slug: `${name.toLowerCase()}-${Date.now()}`,
      })
    ).json() as {
      workspace: WorkspaceView;
    }
  ).workspace;
  await as(t, admin).put(`/api/workspaces/${ws.id}/members/${wsAdmin.principal.id}`, {
    role: 'admin',
  });
  await as(t, admin).delete(`/api/workspaces/${ws.id}/members/${admin.principal.id}`);
  return ws;
}

async function customModel(model: string): Promise<string> {
  const res = await as(t, admin).post('/api/models/custom', {
    provider: 'fake',
    model,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
      pdf: false,
      tools: false,
      structuredOutput: false,
      promptCaching: false,
      reasoning: false,
    },
    prices: {
      inputMicroUsdPerMtok: 100_000,
      outputMicroUsdPerMtok: 200_000,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  });
  return (res.json() as { model: ModelView }).model.id;
}

beforeAll(async () => {
  t = await createTestApp();
  [admin, alphaAdmin, alphaMember, bravoAdmin] = await Promise.all([
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Alpha Admin'),
    signedInUser(t, 'Alpha Member'),
    signedInUser(t, 'Bravo Admin'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  alpha = await workspaceWithAdmin('Alpha', alphaAdmin);
  bravo = await workspaceWithAdmin('Bravo', bravoAdmin);
  await as(t, admin).put(`/api/workspaces/${alpha.id}/members/${alphaMember.principal.id}`, {
    role: 'member',
  });
  // Credentials for the fake endpoint and Anthropic, none for Google. No request is ever sent.
  await as(t, admin).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  await as(t, admin).post('/api/providers', { kind: 'anthropic', apiKey: 'sk-ant-unused' });
  small = await customModel('small');
  large = await customModel('large');
});

afterAll(async () => {
  await t.close();
});

describe('models a workspace can use', () => {
  it('PR-8: lists priced models with a credential for their provider, to members too', async () => {
    const res = await as(t, alphaMember).get(`/api/workspaces/${alpha.id}/models`);
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { models: ModelView[] }).models.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([small, large, 'anthropic:claude-sonnet-4-5']));
    expect(ids.some((id) => id.startsWith('google:'))).toBe(false);
    expect((await as(t, bravoAdmin).get(`/api/workspaces/${alpha.id}/models`)).statusCode).toBe(
      404,
    );
  });
});

describe('routes (RT-1, RT-2)', () => {
  let codeRoute: RouteView;

  it('RT-1, RT-2, RT-5: a workspace admin adds a route with examples; thresholds default per direction', async () => {
    const before = (await policyOf(alphaAdmin, alpha)).settings.policyVersion;
    const res = await as(t, alphaAdmin).post(
      `/api/workspaces/${alpha.id}/routes`,
      route({ fallbacks: [small], signals: ['code_fence'] }),
    );
    expect(res.statusCode).toBe(201);
    codeRoute = (res.json() as { route: RouteView }).route;
    expect(codeRoute).toMatchObject({
      name: 'code',
      model: large,
      fallbacks: [small],
      thresholdDown: DEFAULT_THRESHOLD_DOWN,
      thresholdUp: DEFAULT_THRESHOLD_UP,
      enabled: true,
      signals: ['code_fence'],
      examples: ['Fix this TypeScript error', 'Write a SQL query that joins two tables'],
      compiled: null,
    });
    const policy = await policyOf(alphaAdmin, alpha);
    expect(policy.routes.map((r) => r.id)).toEqual([codeRoute.id]);
    expect(policy.settings.policyVersion).toBe(before + 1);
  });

  it('keeps unchanged examples and their embeddings; changing the examples drops the centroid until it is recompiled', async () => {
    await t.pool.query(
      `update route_examples set embedding = '[0.6,0.8]', embedding_model = 'test-model' where route_id = $1`,
      [codeRoute.id],
    );
    await t.pool.query(
      `insert into route_centroids (route_id, workspace_id, embedding, embedding_model, example_count) values ($1, $2, '[0.6,0.8]', 'test-model', 2)`,
      [codeRoute.id, alpha.id],
    );
    const same = await as(t, alphaAdmin).put(
      `/api/workspaces/${alpha.id}/routes/${codeRoute.id}`,
      route({ fallbacks: [small], signals: ['code_fence'], thresholdUp: 0.3 }),
    );
    expect((same.json() as { route: RouteView }).route.compiled).toMatchObject({
      model: 'test-model',
      exampleCount: 2,
    });

    const changed = await as(t, alphaAdmin).put(
      `/api/workspaces/${alpha.id}/routes/${codeRoute.id}`,
      route({
        fallbacks: [small],
        signals: ['code_fence'],
        examples: ['Fix this TypeScript error', 'Refactor this Python class'],
      }),
    );
    expect((changed.json() as { route: RouteView }).route).toMatchObject({
      examples: ['Fix this TypeScript error', 'Refactor this Python class'],
      compiled: null,
    });
    const reordered = await as(t, alphaAdmin).put(
      `/api/workspaces/${alpha.id}/routes/${codeRoute.id}`,
      route({
        fallbacks: [small],
        signals: ['code_fence'],
        examples: ['Refactor this Python class', 'Fix this TypeScript error'],
      }),
    );
    expect((reordered.json() as { route: RouteView }).route.examples).toEqual([
      'Refactor this Python class',
      'Fix this TypeScript error',
    ]);
    const kept = await t.pool.query<{ text: string; embedding_model: string | null }>(
      'select text, embedding_model from route_examples where route_id = $1 order by text',
      [codeRoute.id],
    );
    expect(kept.rows).toEqual([
      { text: 'Fix this TypeScript error', embedding_model: 'test-model' },
      { text: 'Refactor this Python class', embedding_model: null },
    ]);
  });

  it('refuses models the workspace cannot use, cross-provider fallbacks without consent, and claimed signals', async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [route({ name: 'a', model: 'fake:nope' }), 400, 'invalid_request'],
      [route({ name: 'b', model: 'google:gemini-2.5-flash' }), 400, 'invalid_request'],
      [route({ name: 'c', fallbacks: ['anthropic:claude-sonnet-4-5'] }), 400, 'invalid_request'],
      [route({ name: 'd', signals: ['code_fence'] }), 409, 'signal_claimed'],
      [route({ name: 'code' }), 409, 'route_exists'],
      [route({ name: 'Bad Name' }), 400, 'invalid_request'],
      [route({ name: 'e', thresholdDown: 0.5, thresholdUp: 0.6 }), 400, 'invalid_request'],
      [
        route({ name: 'f', examples: Array.from({ length: 201 }, (_, i) => `example ${i}`) }),
        400,
        'invalid_request',
      ],
    ];
    for (const [body, status, expected] of cases) {
      const res = await as(t, alphaAdmin).post(`/api/workspaces/${alpha.id}/routes`, body);
      expect({ name: body['name'], status: res.statusCode, code: code(res) }).toEqual({
        name: body['name'],
        status,
        code: expected,
      });
    }
    const allowed = await as(t, alphaAdmin).post(
      `/api/workspaces/${alpha.id}/routes`,
      route({
        name: 'writing',
        model: small,
        fallbacks: ['anthropic:claude-sonnet-4-5'],
        allowCrossProvider: true,
        signals: ['code_file'],
      }),
    );
    expect(allowed.statusCode).toBe(201);
  });

  it('RT-5: Postgres refuses a route whose cheaper direction needs less confidence', async () => {
    const direct = await t.pool
      .query(
        `insert into routes (id, workspace_id, name, model, threshold_down, threshold_up, created_by_principal_id)
         values (gen_random_uuid(), $1, 'sneaky', 'fake:large', 0.4, 0.6, $2)`,
        [alpha.id, alphaAdmin.principal.id],
      )
      .then(
        () => 'inserted',
        (e: { constraint?: string }) => e.constraint,
      );
    expect(direct).toBe('routes_thresholds_check');
  });

  it('deleting a route removes it and its examples', async () => {
    const extra = (
      (
        await as(t, alphaAdmin).post(
          `/api/workspaces/${alpha.id}/routes`,
          route({ name: 'scratch', signals: [] }),
        )
      ).json() as { route: RouteView }
    ).route;
    expect(
      (await as(t, alphaAdmin).delete(`/api/workspaces/${alpha.id}/routes/${extra.id}`)).statusCode,
    ).toBe(204);
    expect(
      (await as(t, alphaAdmin).delete(`/api/workspaces/${alpha.id}/routes/${extra.id}`)).statusCode,
    ).toBe(404);
    const examples = await t.pool.query('select 1 from route_examples where route_id = $1', [
      extra.id,
    ]);
    expect(examples.rowCount).toBe(0);
  });
});

describe('workspace routing settings (RT-11)', () => {
  it('RT-11: routing can be turned off, with a default and a pinned model that the workspace can use', async () => {
    const res = await as(t, alphaAdmin).put(`/api/workspaces/${alpha.id}/routing/settings`, {
      routingEnabled: false,
      defaultModel: small,
      pinnedModel: null,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as RoutingPolicyView).settings).toMatchObject({
      routingEnabled: false,
      defaultModel: small,
      pinnedModel: null,
    });
    const unusable = await as(t, alphaAdmin).put(`/api/workspaces/${alpha.id}/routing/settings`, {
      routingEnabled: true,
      defaultModel: 'google:gemini-2.5-flash',
      pinnedModel: null,
    });
    expect(unusable.statusCode).toBe(400);
  });
});

describe('who can see and change routing policy', () => {
  it('ID-3: members can neither read nor change it', async () => {
    expect((await as(t, alphaMember).get(`/api/workspaces/${alpha.id}/routing`)).statusCode).toBe(
      403,
    );
    expect(
      (await as(t, alphaMember).post(`/api/workspaces/${alpha.id}/routes`, route({ name: 'm' })))
        .statusCode,
    ).toBe(403);
  });

  it('AC 16: another workspace cannot read, change or delete it, even with a known id', async () => {
    const [target] = (await policyOf(alphaAdmin, alpha)).routes;
    expect((await as(t, bravoAdmin).get(`/api/workspaces/${alpha.id}/routing`)).statusCode).toBe(
      404,
    );
    expect(
      (await as(t, bravoAdmin).put(`/api/workspaces/${alpha.id}/routes/${target?.id}`, route()))
        .statusCode,
    ).toBe(404);
    // Through their own workspace's path, the other workspace's route does not exist.
    expect(
      (await as(t, bravoAdmin).delete(`/api/workspaces/${bravo.id}/routes/${target?.id}`))
        .statusCode,
    ).toBe(404);
    expect((await policyOf(alphaAdmin, alpha)).routes.map((r) => r.id)).toContain(target?.id);
  });

  it("NF-S2: a key cannot read or change routing policy, even an admin's key", async () => {
    const issued = (
      await as(t, alphaAdmin).post(`/api/workspaces/${alpha.id}/keys`, { name: 'k' })
    ).json() as IssuedKey;
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/workspaces/${alpha.id}/routing`,
      headers: { authorization: `Bearer ${issued.secret}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('NF-S5: example phrasings never reach the logs', () => {
    const logs = t.logs.join('\n');
    expect(logs).toContain('"msg":"routing.route_created"');
    expect(logs).not.toContain('TypeScript error');
  });
});
