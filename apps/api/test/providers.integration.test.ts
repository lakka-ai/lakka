import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorBody, ProviderNotConfiguredError } from '@lakka/contracts';
import type {
  IssuedKey,
  ProviderConfigView,
  ProviderTestResult,
  WorkspaceView,
} from '@lakka/contracts';
import { resolveProviderConnection } from '@lakka/core';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Provider credentials (PR-1, PR-2, PR-3, PR-8, AC 16, AC 17, ADR 0038) against real Postgres.
 * Credential tests reach a fake provider through an injected fetch: a request carrying
 * GOOD_KEY is accepted, any other key refused, and an address containing "unreachable" fails.
 */

const GOOD_KEY = 'sk-good-0123456789abcdef';
const BAD_KEY = 'sk-bad-0123456789abcdef';
const WORKSPACE_KEY = 'sk-workspace-0123456789abcdef';
const secrets = [GOOD_KEY, BAD_KEY, WORKSPACE_KEY];

const probes: { url: string; headers: Headers }[] = [];
const fakeProvider: typeof fetch = async (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  probes.push({ url, headers });
  if (url.includes('unreachable')) throw new TypeError('fetch failed');
  const presented =
    headers.get('x-api-key') ??
    headers.get('x-goog-api-key') ??
    headers.get('authorization')?.replace(/^Bearer /, '');
  return new Response('{"data":[]}', {
    status: presented === GOOD_KEY || presented === WORKSPACE_KEY ? 200 : 401,
  });
};

let t: TestApp;
let admin: SignedInUser; // instance admin
let alphaAdmin: SignedInUser;
let alphaMember: SignedInUser;
let bravoAdmin: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;

const code = (res: { json(): unknown }) => apiErrorBody.parse(res.json()).error.code;
const provider = (res: { json(): unknown }) =>
  (res.json() as { provider: ProviderConfigView }).provider;
const providers = (res: { json(): unknown }) =>
  (res.json() as { providers: ProviderConfigView[] }).providers;

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

beforeAll(async () => {
  t = await createTestApp({ providerFetch: fakeProvider });
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
});

afterAll(async () => {
  await t.close();
});

describe('instance-wide credentials', () => {
  let anthropicId: string;

  it('PR-1, PR-2, PR-3: an admin adds a key; it is stored encrypted and never returned', async () => {
    const res = await as(t, admin).post('/api/providers', { kind: 'anthropic', apiKey: GOOD_KEY });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(GOOD_KEY);
    const created = provider(res);
    anthropicId = created.id;
    expect(created).toMatchObject({
      kind: 'anthropic',
      name: 'anthropic',
      workspaceId: null,
      hasKey: true,
      baseUrl: null,
      lastTest: null,
    });

    const stored = await t.pool.query<{ api_key: string }>(
      'select api_key from provider_configs where id = $1',
      [anthropicId],
    );
    expect(stored.rows[0]?.api_key).toMatch(/^v1:/);
    expect(stored.rows[0]?.api_key).not.toContain(GOOD_KEY);

    const list = await as(t, admin).get('/api/providers');
    expect(list.body).not.toContain(GOOD_KEY);
    expect(providers(list).map((p) => p.id)).toEqual([anthropicId]);
  });

  it('PR-1: testing a credential makes a free model-list call and records the outcome', async () => {
    const res = await as(t, admin).post(`/api/providers/${anthropicId}/test`, {});
    expect((res.json() as { result: ProviderTestResult }).result).toMatchObject({
      status: 'ok',
      httpStatus: 200,
    });
    const probe = probes.at(-1);
    expect(probe?.url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(probe?.headers.get('x-api-key')).toBe(GOOD_KEY);
    const [listed] = providers(await as(t, admin).get('/api/providers'));
    expect(listed?.lastTest).toMatchObject({ status: 'ok', httpStatus: 200 });
  });

  it('PR-1: a refused key and an unreachable address are told apart; replacing the key clears the old result', async () => {
    const replaced = await as(t, admin).put(`/api/providers/${anthropicId}`, { apiKey: BAD_KEY });
    expect(replaced.body).not.toContain(BAD_KEY);
    expect(provider(replaced).lastTest).toBeNull();
    const refused = await as(t, admin).post(`/api/providers/${anthropicId}/test`, {});
    expect((refused.json() as { result: ProviderTestResult }).result).toMatchObject({
      status: 'auth_failed',
      httpStatus: 401,
    });
    await as(t, admin).put(`/api/providers/${anthropicId}`, { apiKey: GOOD_KEY });

    const local = provider(
      await as(t, admin).post('/api/providers', {
        kind: 'openai-compatible',
        name: 'vllm',
        baseUrl: 'http://unreachable.internal:8000/v1/',
      }),
    );
    expect(local).toMatchObject({
      name: 'vllm',
      baseUrl: 'http://unreachable.internal:8000/v1',
      hasKey: false,
    });
    const res = await as(t, admin).post(`/api/providers/${local.id}/test`, {});
    expect((res.json() as { result: ProviderTestResult }).result).toMatchObject({
      status: 'unreachable',
      httpStatus: null,
    });
  });

  it('PR-4: a key for DeepSeek is checked at its standard address, and its models are named deepseek', async () => {
    const res = await as(t, admin).post('/api/providers', { kind: 'deepseek', apiKey: GOOD_KEY });
    expect(res.statusCode).toBe(201);
    const created = provider(res);
    expect(created).toMatchObject({ kind: 'deepseek', name: 'deepseek', baseUrl: null });
    probes.length = 0;
    const tested = await as(t, admin).post(`/api/providers/${created.id}/test`, {});
    expect(tested.json()).toMatchObject({ result: { status: 'ok', httpStatus: 200 } });
    expect(probes.map((p) => p.url)).toEqual(['https://api.deepseek.com/models']);
    const models = await as(t, admin).get('/api/models');
    expect(JSON.stringify(models.json())).toContain('deepseek:deepseek-v4-pro');
  });

  it('refuses a duplicate name in the same scope, reserved names, and malformed addresses', async () => {
    const dup = await as(t, admin).post('/api/providers', { kind: 'anthropic', apiKey: GOOD_KEY });
    expect(dup.statusCode).toBe(409);
    expect(code(dup)).toBe('provider_exists');
    const cases = [
      { kind: 'openai-compatible', name: 'openai', baseUrl: 'http://x.internal/v1' },
      { kind: 'openai-compatible', name: 'deepseek', baseUrl: 'http://x.internal/v1' },
      { kind: 'zai', baseUrl: 'http://x.internal/v1' },
      { kind: 'openai-compatible', name: 'nourl' },
      { kind: 'openai-compatible', name: 'creds', baseUrl: 'http://user:pw@x.internal/v1' },
      { kind: 'openai-compatible', name: 'ftp', baseUrl: 'ftp://x.internal/v1' },
      { kind: 'openai' },
      { kind: 'google', name: 'gemini', apiKey: GOOD_KEY },
    ];
    for (const body of cases) {
      const res = await as(t, admin).post('/api/providers', body);
      expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
    }
  });

  it('NF-S2: people who are not instance admins, and keys, cannot touch instance credentials', async () => {
    expect((await as(t, alphaAdmin).get('/api/providers')).statusCode).toBe(403);
    expect(
      (await as(t, alphaAdmin).post('/api/providers', { kind: 'openai', apiKey: GOOD_KEY }))
        .statusCode,
    ).toBe(403);
    const ws = (
      (
        await as(t, admin).post('/api/workspaces', { name: 'K', slug: `k-${Date.now()}` })
      ).json() as { workspace: WorkspaceView }
    ).workspace;
    const issued = (
      await as(t, admin).post(`/api/workspaces/${ws.id}/keys`, { name: 'k' })
    ).json() as IssuedKey;
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/providers',
      headers: { authorization: `Bearer ${issued.secret}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('workspace credentials (PR-8)', () => {
  let alphaOpenAi: string;

  it('PR-8: a workspace admin adds their own key, which wins over the instance key for that workspace only', async () => {
    await as(t, admin).post('/api/providers', { kind: 'openai', apiKey: GOOD_KEY });
    const res = await as(t, alphaAdmin).post(`/api/workspaces/${alpha.id}/providers`, {
      kind: 'openai',
      apiKey: WORKSPACE_KEY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(WORKSPACE_KEY);
    alphaOpenAi = provider(res).id;
    expect(provider(res).workspaceId).toBe(alpha.id);

    expect((await resolveProviderConnection(t, alpha.id, 'openai')).apiKey).toBe(WORKSPACE_KEY);
    expect((await resolveProviderConnection(t, bravo.id, 'openai')).apiKey).toBe(GOOD_KEY);
    const tested = await as(t, alphaAdmin).post(
      `/api/workspaces/${alpha.id}/providers/${alphaOpenAi}/test`,
      {},
    );
    expect((tested.json() as { result: ProviderTestResult }).result.status).toBe('ok');
    expect(probes.at(-1)?.headers.get('authorization')).toBe(`Bearer ${WORKSPACE_KEY}`);
  });

  it('PR-8: without its own key a workspace falls back to the instance; with neither, the provider is not configured', async () => {
    expect(
      (await as(t, alphaAdmin).delete(`/api/workspaces/${alpha.id}/providers/${alphaOpenAi}`))
        .statusCode,
    ).toBe(204);
    expect((await resolveProviderConnection(t, alpha.id, 'openai')).apiKey).toBe(GOOD_KEY);
    await expect(resolveProviderConnection(t, alpha.id, 'google')).rejects.toBeInstanceOf(
      ProviderNotConfiguredError,
    );
    await expect(resolveProviderConnection(t, alpha.id, 'nobody')).rejects.toBeInstanceOf(
      ProviderNotConfiguredError,
    );
  });

  it('ADR 0038: a workspace credential cannot choose where the server connects', async () => {
    const compatible = await as(t, alphaAdmin).post(`/api/workspaces/${alpha.id}/providers`, {
      kind: 'openai-compatible',
      name: 'internal',
      baseUrl: 'http://169.254.169.254/latest',
    });
    expect(compatible.statusCode).toBe(400);
    const overridden = await as(t, alphaAdmin).post(`/api/workspaces/${alpha.id}/providers`, {
      kind: 'anthropic',
      apiKey: WORKSPACE_KEY,
      baseUrl: 'http://postgres.internal:5432',
    });
    expect(overridden.statusCode).toBe(400);
    const google = provider(
      await as(t, alphaAdmin).post(`/api/workspaces/${alpha.id}/providers`, {
        kind: 'google',
        apiKey: WORKSPACE_KEY,
      }),
    );
    const moved = await as(t, alphaAdmin).put(
      `/api/workspaces/${alpha.id}/providers/${google.id}`,
      {
        baseUrl: 'http://10.0.0.5/v1',
      },
    );
    expect(moved.statusCode).toBe(400);
    // Postgres refuses it too, whatever the application code does.
    const direct = await t.pool
      .query(
        `insert into provider_configs (id, workspace_id, kind, name, base_url, created_by_principal_id)
         values (gen_random_uuid(), $1, 'openai-compatible', 'sneaky', 'http://10.0.0.5/v1', $2)`,
        [alpha.id, alphaAdmin.principal.id],
      )
      .then(
        () => 'inserted',
        (e: { constraint?: string }) => e.constraint,
      );
    expect(direct).toBe('provider_configs_workspace_scope_check');
  });

  it('PR-2, ADR 0096: a workspace admin sees whose key each provider uses, and nothing of the instance key', async () => {
    // Alpha now has its own Google key; the instance has Anthropic and OpenAI keys.
    const res = await as(t, alphaAdmin).get(`/api/workspaces/${alpha.id}/providers/coverage`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      coverage: [
        { kind: 'anthropic', source: 'instance', instanceKey: true },
        { kind: 'openai', source: 'instance', instanceKey: true },
        { kind: 'google', source: 'workspace', instanceKey: false },
        { kind: 'deepseek', source: 'instance', instanceKey: true },
        { kind: 'moonshot', source: 'none', instanceKey: false },
        { kind: 'qwencloud', source: 'none', instanceKey: false },
        { kind: 'xiaomi-mimo', source: 'none', instanceKey: false },
        { kind: 'zai', source: 'none', instanceKey: false },
      ],
    });
    expect(res.body).not.toContain(GOOD_KEY);
    expect(
      (await as(t, bravoAdmin).get(`/api/workspaces/${bravo.id}/providers/coverage`)).json(),
    ).toMatchObject({
      coverage: expect.arrayContaining([{ kind: 'google', source: 'none', instanceKey: false }]),
    });
    expect(
      (await as(t, alphaMember).get(`/api/workspaces/${alpha.id}/providers/coverage`)).statusCode,
    ).toBe(403);
    expect(
      (await as(t, bravoAdmin).get(`/api/workspaces/${alpha.id}/providers/coverage`)).statusCode,
    ).toBe(404);
  });

  it('PR-8: a workspace admin can add its own key for a compatible first-party provider', async () => {
    const res = await as(t, bravoAdmin).post(`/api/workspaces/${bravo.id}/providers`, {
      kind: 'zai',
      apiKey: WORKSPACE_KEY,
    });
    expect(res.statusCode).toBe(201);
    expect(provider(res)).toMatchObject({ kind: 'zai', name: 'zai', workspaceId: bravo.id });
    const coverage = await as(t, bravoAdmin).get(`/api/workspaces/${bravo.id}/providers/coverage`);
    expect(coverage.json()).toMatchObject({
      coverage: expect.arrayContaining([{ kind: 'zai', source: 'workspace', instanceKey: false }]),
    });
  });

  it('ID-3: members cannot see or manage their workspace credentials', async () => {
    expect((await as(t, alphaMember).get(`/api/workspaces/${alpha.id}/providers`)).statusCode).toBe(
      403,
    );
    expect(
      (
        await as(t, alphaMember).post(`/api/workspaces/${alpha.id}/providers`, {
          kind: 'anthropic',
          apiKey: GOOD_KEY,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('AC 16: another workspace cannot see, test or remove them, even with a known id', async () => {
    const bravoKey = provider(
      await as(t, bravoAdmin).post(`/api/workspaces/${bravo.id}/providers`, {
        kind: 'anthropic',
        apiKey: WORKSPACE_KEY,
      }),
    );
    expect((await as(t, alphaAdmin).get(`/api/workspaces/${bravo.id}/providers`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await as(t, alphaAdmin).post(
          `/api/workspaces/${bravo.id}/providers/${bravoKey.id}/test`,
          {},
        )
      ).statusCode,
    ).toBe(404);
    // Through their own workspace's path, the other workspace's credential does not exist.
    expect(
      (await as(t, alphaAdmin).delete(`/api/workspaces/${alpha.id}/providers/${bravoKey.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await as(t, alphaAdmin).put(`/api/workspaces/${alpha.id}/providers/${bravoKey.id}`, {
          apiKey: BAD_KEY,
        })
      ).statusCode,
    ).toBe(404);
    // Nor through the instance path.
    expect((await as(t, admin).delete(`/api/providers/${bravoKey.id}`)).statusCode).toBe(404);
    expect((await resolveProviderConnection(t, bravo.id, 'anthropic')).apiKey).toBe(WORKSPACE_KEY);
  });

  it('NF-S5, AC 17: no key reaches the logs', () => {
    const logs = t.logs.join('\n');
    for (const secret of secrets) expect(logs).not.toContain(secret);
    expect(logs).toContain('"msg":"providers.created"');
  });
});

describe('credential tests over real HTTP', () => {
  it('a redirect is not followed, so the key never goes to another address', async () => {
    const elsewhere: string[] = [];
    const target = createServer((req, res) => {
      elsewhere.push(req.headers.authorization ?? '');
      res.end('{}');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as AddressInfo).port;
    const redirecting = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/v1/models` }).end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
    const port = (redirecting.address() as AddressInfo).port;

    const real = await createTestApp();
    try {
      const realAdmin = await signedInUser(real, 'Real Admin');
      await real.pool.query('update principals set is_instance_admin = true where id = $1', [
        realAdmin.principal.id,
      ]);
      const created = provider(
        await as(real, realAdmin).post('/api/providers', {
          kind: 'openai-compatible',
          name: 'moved',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: GOOD_KEY,
        }),
      );
      const res = await as(real, realAdmin).post(`/api/providers/${created.id}/test`, {});
      expect((res.json() as { result: ProviderTestResult }).result).toMatchObject({
        status: 'error',
        httpStatus: 302,
      });
      expect(elsewhere).toEqual([]);
    } finally {
      await real.close();
      redirecting.close();
      target.close();
    }
  });
});
