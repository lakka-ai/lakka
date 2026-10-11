import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IssuedKey, ModelView, WorkspaceView } from '@lakka/contracts';
import { diagnosticsEntries, loadConfig, noClassifier, tarStream } from '@lakka/core';
import { createPool, schema } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, CREDENTIAL_KEY, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The diagnostics bundle (AD-3, AC 17, ADR 0083), against real Postgres and Valkey. Every kind
 * of secret the instance holds is planted with a recognisable value, along with prompts, names
 * and emails, and none of them may appear anywhere in the bundle. The bundle still has what
 * support needs, and is still written when the database is down.
 */

const tag = randomBytes(6).toString('hex');
const canary = (what: string) => `canary-${what}-${tag}`;
const secrets = {
  instanceProviderKey: canary('instance-provider-key'),
  workspaceProviderKey: `sk-${canary('workspace-provider-key')}`,
  mcpShared: canary('mcp-shared'),
  oidcClientSecret: canary('oidc-client-secret'),
  databasePassword: canary('database-password'),
  cachePassword: canary('cache-password'),
  otlpHeader: canary('otlp-header'),
  otlpQuery: canary('otlp-query'),
};
const said = canary('prompt');
const workspaceName = `Diag ${tag}`;

const EXPECTED_FILES = [
  'cache.json',
  'config.json',
  'database.json',
  'errors.jsonl',
  'health.json',
  'instance.json',
  'jobs.json',
  'manifest.json',
  'sandbox.json',
  'system.json',
];

let t: TestApp;
let fake: FakeProvider;
let base: string;
let root: SignedInUser;
let member: SignedInUser;
let ws: WorkspaceView;
let issued: IssuedKey;
let webhookSecret: string;

/** The bundle's files by name, unpacked with the system tar. */
async function bundle(url: string, user: SignedInUser): Promise<Map<string, string>> {
  const res = await fetch(`${url}/api/diagnostics`, {
    headers: { cookie: user.cookie, origin: PUBLIC_URL },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/gzip');
  expect(res.headers.get('content-disposition')).toMatch(
    /^attachment; filename="lakka-diagnostics-[0-9T-]+Z\.tar\.gz"$/,
  );
  const dir = mkdtempSync(join(tmpdir(), 'lakka-diagnostics-'));
  try {
    const archive = join(dir, 'bundle.tar.gz');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    execFileSync('tar', ['-xzf', archive, '-C', dir]);
    const inner = join(dir, 'lakka-diagnostics');
    return new Map(
      readdirSync(inner).map((name) => [name, readFileSync(join(inner, name), 'utf8')]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function listen(app: TestApp): Promise<string> {
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.app.server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  fake = await startFakeProvider();
  t = await createTestApp({
    // In the config the bundle reads only: the app's own tracer sends nothing anywhere.
    configEnv: {
      LAKKA_OTLP_ENDPOINT: `https://collector.example.com/v1/traces?api_key=${secrets.otlpQuery}`,
      LAKKA_OTLP_HEADERS: `authorization=Bearer ${secrets.otlpHeader}`,
      LAKKA_DATABASE_PASSWORD: secrets.databasePassword,
      LAKKA_CACHE_PASSWORD: secrets.cachePassword,
    },
  });
  base = await listen(t);
  [root, member] = await Promise.all([signedInUser(t, 'Root'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  ws = (
    (
      await as(t, root).post('/api/workspaces', { name: workspaceName, slug: `diag-${tag}` })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  await as(t, root).put(`/api/workspaces/${ws.id}/members/${member.principal.id}`, {
    role: 'member',
  });

  // Every kind of credential the instance keeps.
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
    apiKey: secrets.instanceProviderKey,
  });
  await as(t, root).post(`/api/workspaces/${ws.id}/providers`, {
    kind: 'openai',
    apiKey: secrets.workspaceProviderKey,
  });
  const [server] = await t.db
    .insert(schema.mcpServers)
    .values({
      workspaceId: ws.id,
      name: `shared-${tag}`,
      transport: 'streamable_http',
      url: `https://mcp-${tag}.example.com/mcp`,
      authMode: 'shared',
      createdByPrincipalId: root.principal.id,
    })
    .returning({ id: schema.mcpServers.id });
  await t.db.insert(schema.mcpCredentials).values({
    mcpServerId: server?.id ?? '',
    principalId: root.principal.id,
    kind: 'shared',
    secret: secrets.mcpShared,
  });
  await t.db.insert(schema.ssoProviders).values({
    id: `sso-${tag}`,
    issuer: `https://idp-${tag}.example.com`,
    providerId: `idp-${tag}`,
    domain: 'example.com',
    oidcConfig: JSON.stringify({ clientId: 'lakka', clientSecret: secrets.oidcClientSecret }),
  });
  webhookSecret = (
    (
      await as(t, root).put('/api/budgets/webhook', { url: 'https://hooks.example.com/budget' })
    ).json() as { secret: string }
  ).secret;
  issued = (
    await as(t, member).post(`/api/workspaces/${ws.id}/keys`, { name: `Key ${tag}` })
  ).json() as IssuedKey;

  // Something said, recorded, and a request a cap refused, so there is an error span.
  const model = (
    (
      await as(t, root).post('/api/models/custom', {
        provider: 'fake',
        model: `ok~${tag}`,
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
          inputMicroUsdPerMtok: 1_000_000,
          outputMicroUsdPerMtok: 2_000_000,
          cacheReadMicroUsdPerMtok: null,
          cacheWriteMicroUsdPerMtok: null,
        },
      })
    ).json() as { model: ModelView }
  ).model;
  await as(t, root).put(`/api/workspaces/${ws.id}/content-capture`, {
    enabled: true,
    retentionDays: 7,
  });
  const ask = () =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 100,
        messages: [{ role: 'user', content: `Remember ${said}` }],
      }),
    }).then((r) => r.text());
  await ask();
  await as(t, root).put(`/api/workspaces/${ws.id}/budgets/members/${member.principal.id}`, {
    limitMicroUsd: '1',
    period: 'monthly',
  });
  await ask();
  for (let i = 0; i < 40; i += 1) {
    await t.tracing.forceFlush();
    const { rows } = await t.pool.query("select 1 from spans where status = 'error' limit 1");
    if (rows.length > 0) break;
    await sleep(50);
  }
});

afterAll(async () => {
  await fake?.close();
  await t?.close();
});

describe('the diagnostics bundle (AD-3)', () => {
  it('AD-3: only an instance admin may download it', async () => {
    expect((await as(t, member).get('/api/diagnostics')).statusCode).toBe(403);
    const byKey = await t.app.inject({
      method: 'GET',
      url: '/api/diagnostics',
      headers: { authorization: `Bearer ${issued.secret}` },
    });
    expect(byKey.statusCode).toBe(403);
  });

  it('AC 17: no credential, secret, prompt, name or email appears anywhere in it', async () => {
    const files = await bundle(base, root);
    expect([...files.keys()].toSorted()).toEqual(EXPECTED_FILES);
    const all = [...files.values()].join('\n');
    const forbidden = {
      ...secrets,
      credentialMasterKey: CREDENTIAL_KEY,
      authSecret: 'integration-tests-only-auth-secret-0123456789abcdef',
      setupCode: t.setupCode ?? '',
      webhookSecret,
      apiKey: issued.secret,
      sessionCookie: root.cookie.split('=')[1] ?? '',
      password: root.password,
      memberPassword: member.password,
      prompt: said,
      reply: 'Hello there',
      rootEmail: root.email,
      memberEmail: member.email,
      workspaceName,
      keyName: `Key ${tag}`,
      mcpAddress: `mcp-${tag}.example.com`,
      idpAddress: `idp-${tag}.example.com`,
      fakeProviderAddress: fake.url,
      toolHostToken: t.sandbox.token,
      egressKey: t.sandbox.egressKey,
    };
    const entries = Object.entries(forbidden);
    // Every canary was really planted, and none of them came out: failures name the item.
    expect(entries.filter(([, value]) => value === '').map(([what]) => what)).toEqual([]);
    expect(entries.filter(([, value]) => all.includes(value)).map(([what]) => what)).toEqual([]);
  });

  it('AD-3: holds what support needs to tell what is wrong', async () => {
    const files = await bundle(base, root);
    const read = (name: string) => JSON.parse(files.get(name) ?? 'null') as Record<string, unknown>;

    expect(read('manifest.json')).toMatchObject({
      format: 'lakka.diagnostics',
      version: 1,
      generatedBy: { via: 'api', principalId: root.principal.id },
      build: { version: 'dev', revision: 'unknown' },
    });
    expect(read('config.json')).toMatchObject({
      database: { passwordSet: true },
      cache: { passwordSet: true },
      auth: { publicUrl: PUBLIC_URL, secretSet: true },
      credentials: { masterKeySet: true },
      otlp: { enabled: true, destination: 'https://collector.example.com', headerCount: 1 },
      setup: { codeSet: true },
    });
    // NF-S4: whether stdio servers can run, never the keys (ADR 0118).
    expect(read('sandbox.json')).toEqual({
      toolHost: 'ok',
      egress: 'unreachable',
      keys: { toolHostToken: true, egressKey: true },
    });
    expect(read('config.json')).toMatchObject({
      sandbox: { toolHost: { kind: 'unix' }, egressProxy: 'http://egress:3128', slots: 8 },
    });
    expect(read('health.json')).toMatchObject({
      checks: {
        database: { status: 'ok' },
        cache: { status: 'ok' },
        'provider:fake': { status: 'ok' },
      },
    });
    const database = read('database.json') as {
      extensions: { name: string }[];
      migrations: { applied: number };
      tables: { name: string; partition_of: string | null }[];
    };
    expect(database.extensions.map((e) => e.name)).toContain('vector');
    expect(database.migrations.applied).toBeGreaterThan(20);
    expect(database.tables.some((x) => x.name === 'usage')).toBe(true);
    expect(database.tables.some((x) => x.partition_of === 'spans')).toBe(true);
    expect(Object.keys(read('cache.json'))).toEqual(
      expect.arrayContaining(['uptime_in_seconds', 'used_memory', 'keys']),
    );
    const instance = read('instance.json') as {
      workspaces: { id: string; members: number; active_keys: number; content_capture: boolean }[];
      providers: { kind: string; name: string; has_key: boolean; custom_base_url: boolean }[];
      ssoProviders: number;
    };
    expect(instance.workspaces.find((w) => w.id === ws.id)).toMatchObject({
      members: 2,
      active_keys: 1,
      content_capture: true,
    });
    expect(instance.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'openai-compatible',
          name: 'fake',
          has_key: true,
          custom_base_url: true,
        }),
        expect.objectContaining({ kind: 'openai', has_key: true, custom_base_url: false }),
      ]),
    );
    expect(instance.ssoProviders).toBe(1);

    // The refused request's spans, saying what failed but not who asked.
    const errors = (files.get('errors.jsonl') ?? '')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { errorType: string; attributes: Record<string, unknown> });
    expect(errors.some((e) => e.errorType === 'budget_exceeded')).toBe(true);
    const names = errors.flatMap((e) => Object.keys(e.attributes));
    expect(names).toContain('lakka.request_id');
    for (const who of ['lakka.principal_id', 'lakka.acting_user_id', 'lakka.conversation_id']) {
      expect(names).not.toContain(who);
    }
    expect(files.get('errors.jsonl')).not.toContain(member.principal.id);
  });

  it('NF-S5: generating it is logged by who asked, with nothing from inside it', () => {
    const lines = t.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'diagnostics.generated', actor_id: root.principal.id }),
    );
  });

  it('AD-3: with Postgres unreachable, the bundle is still written and says what it could not read', async () => {
    const unreachable = createPool(
      {
        host: '127.0.0.1',
        port: 1,
        user: 'nobody',
        database: 'nothing',
        password: undefined,
        applicationName: 'lakka-tests-unreachable',
        max: 2,
      },
      () => undefined,
    );
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of tarStream(
        diagnosticsEntries({
          pool: unreachable,
          cache: t.cache,
          config: loadConfig({}),
          classifier: noClassifier,
          health: async () => ({ status: 'down', checks: {} }),
          generatedBy: { via: 'operator' },
        }),
      )) {
        chunks.push(chunk);
      }
      const dir = mkdtempSync(join(tmpdir(), 'lakka-diagnostics-'));
      try {
        writeFileSync(join(dir, 'bundle.tar'), Buffer.concat(chunks));
        execFileSync('tar', ['-xf', join(dir, 'bundle.tar'), '-C', dir]);
        const read = (name: string) =>
          JSON.parse(readFileSync(join(dir, 'lakka-diagnostics', name), 'utf8')) as unknown;
        for (const name of ['database.json', 'instance.json', 'jobs.json', 'errors.jsonl']) {
          expect({ [name]: read(name) }).toEqual({ [name]: { unavailable: true } });
        }
        // What does not need the database is there.
        expect(read('cache.json')).toHaveProperty('uptime_in_seconds');
        expect(read('health.json')).toMatchObject({ status: 'down' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await unreachable.end();
    }
  });
});
