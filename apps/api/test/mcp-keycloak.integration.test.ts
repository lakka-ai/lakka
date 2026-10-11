import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ConversationView,
  McpConnectionView,
  McpConnectStartView,
  McpServerView,
  McpToolSyncView,
  ModelView,
  WorkspaceView,
} from '@lakka/contracts';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import {
  configureKeycloak,
  KEYCLOAK_ADMIN,
  KEYCLOAK_IMAGE,
  keycloakVerifier,
  signInAtKeycloak,
} from '../../../test/integration/keycloak.ts';
import type { KeycloakPerson } from '../../../test/integration/keycloak.ts';
import { startMcpHttpServer } from '../../../test/integration/mcp-http-server.ts';
import type { McpHttpFixture } from '../../../test/integration/mcp-http-server.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Per-user credentials against a real authorization server (TL-2, M6 exit, ADR 0074): Keycloak,
 * unmodified, with two people in it. Lakka discovers it from the MCP server's metadata,
 * registers itself dynamically, sends each person through Keycloak's own sign-in and consent,
 * exchanges the code with PKCE, and refreshes tokens as they near expiry. The MCP server, on the
 * official server package, accepts only tokens Keycloak says are active and meant for it, and
 * its whoami tool names whoever the token belongs to.
 */

const PEOPLE: Record<'alice' | 'bob', KeycloakPerson> = {
  alice: { username: 'alice', password: 'alice-keycloak-pw', firstName: 'Alice', lastName: 'A' },
  bob: { username: 'bob', password: 'bob-keycloak-pw', firstName: 'Bob', lastName: 'B' },
};

let keycloak: StartedTestContainer;
let t: TestApp;
let fake: FakeProvider;
let mcp: McpHttpFixture;
let base: string;
let root: SignedInUser;
let alice: SignedInUser;
let bob: SignedInUser;
let alpha: WorkspaceView;
let server: McpServerView;
let model: ModelView;

const suffix = () => randomBytes(3).toString('hex');
const ws = () => `/api/workspaces/${alpha.id}`;

/** Connects `user`'s account, signing in at Keycloak as `person`; returns where they landed. */
async function connect(user: SignedInUser, person: KeycloakPerson, consent: 'accept' | 'deny') {
  const started = await as(t, user).post(`${ws()}/mcp-connections/${server.id}`, {});
  expect(started.statusCode).toBe(200);
  const { authorizationUrl } = started.json() as McpConnectStartView;
  const back = await signInAtKeycloak(authorizationUrl, person, consent);
  expect(`${back.origin}${back.pathname}`).toBe(`${PUBLIC_URL}/api/mcp/oauth/callback`);
  const landed = await t.app.inject({
    method: 'GET',
    url: `${back.pathname}${back.search}`,
    headers: { cookie: user.cookie },
  });
  expect(landed.statusCode).toBe(302);
  return landed.headers.location ?? '';
}

async function connected(user: SignedInUser): Promise<boolean> {
  const res = await as(t, user).get(`${ws()}/mcp-connections`);
  const list = (res.json() as { connections: McpConnectionView[] }).connections;
  return list.find((c) => c.serverId === server.id)?.connected ?? false;
}

/** Asks for whoami through chat, as `user`, and returns what the tool said. */
async function whoami(user: SignedInUser): Promise<string> {
  const conversation = await as(t, user).post(`${ws()}/conversations`, {});
  const id = (conversation.json() as { conversation: { id: string } }).conversation.id;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: user.cookie,
      origin: PUBLIC_URL,
      'x-lakka-workspace': alpha.id,
      'x-lakka-conversation': id,
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Who am I to the server?' }],
    }),
  });
  expect(res.status).toBe(200);
  const view = await as(t, user).get(`${ws()}/conversations/${id}`);
  const result = (view.json() as { conversation: ConversationView }).conversation.messages.find(
    (m) => m.role === 'tool',
  );
  return result?.content ?? '';
}

beforeAll(async () => {
  keycloak = await new GenericContainer(KEYCLOAK_IMAGE)
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: KEYCLOAK_ADMIN.username,
      KC_BOOTSTRAP_ADMIN_PASSWORD: KEYCLOAK_ADMIN.password,
      KC_HEALTH_ENABLED: 'true',
    })
    .withCommand(['start-dev'])
    .withExposedPorts(8080, 9000)
    .withWaitStrategy(Wait.forHttp('/health/ready', 9000).withStartupTimeout(150_000))
    .start();
  const keycloakUrl = `http://127.0.0.1:${keycloak.getMappedPort(8080)}`;
  const setup = await configureKeycloak({
    adminUrl: keycloakUrl,
    people: Object.values(PEOPLE),
    trustedHosts: [new URL(PUBLIC_URL).hostname],
    // Under Lakka's refresh margin, so every call refreshes against Keycloak.
    accessTokenLifespanSeconds: 30,
  });
  mcp = await startMcpHttpServer({
    oauth: { issuer: setup.issuer, userFor: keycloakVerifier(setup), scopes: [] },
  });

  // The server and Keycloak, listed as an instance admin would (NF-S4).
  t = await createTestApp({ mcpAllowedOrigins: [mcp.url, setup.issuer] });
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  [root, alice, bob] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Alice'),
    signedInUser(t, 'Bob'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = (
    (
      await as(t, root).post('/api/workspaces', { name: 'Alpha', slug: `alpha-${suffix()}` })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  for (const user of [alice, bob]) {
    await as(t, root).put(`${ws()}/members/${user.principal.id}`, { role: 'member' });
  }
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  const created = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `tool-whoami~${suffix()}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
      pdf: false,
      tools: true,
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
  });
  model = (created.json() as { model: ModelView }).model;
  // Loopback addresses take an instance admin's server (ADR 0066 Q2).
  const added = await as(t, root).post(`${ws()}/mcp-servers`, {
    transport: 'streamable_http',
    name: `kc${suffix()}`,
    url: mcp.url,
    authMode: 'oauth',
  });
  if (added.statusCode !== 201) throw new Error(added.body);
  server = (added.json() as { server: McpServerView }).server;
});

afterAll(async () => {
  await Promise.all([mcp?.close(), fake?.close()]);
  await t?.close();
  await keycloak?.stop();
});

describe('per-user credentials against Keycloak (TL-2)', () => {
  it('TL-2: a person who declines at Keycloak is not connected', async () => {
    const landed = await connect(bob, PEOPLE.bob, 'deny');
    expect(landed).toBe(`/workspaces/${alpha.id}/connections?result=denied`);
    expect(await connected(bob)).toBe(false);
  });

  it('TL-2: each person connects through Keycloak, and the server sees each of them', async () => {
    expect(await connect(alice, PEOPLE.alice, 'accept')).toContain('result=connected');
    // Lakka registered itself; no admin entered a client.
    const view = await as(t, root).get(`${ws()}/mcp-servers/${server.id}`);
    expect((view.json() as { server: McpServerView }).server.oauthClient).toBe('registered');

    // The admin syncs with their own connection, then enables whoami.
    await connect(root, { ...PEOPLE.alice }, 'accept');
    const synced = await as(t, root).post(`${ws()}/mcp-servers/${server.id}/tools/sync`, {});
    expect(synced.statusCode).toBe(200);
    for (const tool of (synced.json() as McpToolSyncView).tools) {
      if (tool.name === 'whoami') {
        await as(t, root).patch(`${ws()}/tools/${tool.id}`, { enabled: true });
      }
    }

    expect(await connect(bob, PEOPLE.bob, 'accept')).toContain('result=connected');
    expect(await whoami(alice)).toBe('alice');
    expect(await whoami(bob)).toBe('bob');
  });

  it('TL-2: a token near expiry is refreshed at Keycloak before the call', async () => {
    const before = mcp.authorizations.length;
    expect(await whoami(alice)).toBe('alice');
    expect(await whoami(alice)).toBe('alice');
    const presented = mcp.authorizations.slice(before).filter((a) => a !== undefined);
    // Each call carried a token Keycloak had just issued in exchange for the refresh token.
    expect(new Set(presented).size).toBeGreaterThan(1);
  });

  it('TL-2: after disconnecting, the server is not offered to that person', async () => {
    expect((await as(t, bob).delete(`${ws()}/mcp-connections/${server.id}`)).statusCode).toBe(204);
    expect(await connected(bob)).toBe(false);
    // Its tools are listed as waiting for bob to connect, and none is usable (ADR 0096).
    const available = await as(t, bob).get(`${ws()}/tools/available`);
    const tools = (available.json() as { tools: { blockedBy: string | null }[] }).tools;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.blockedBy === 'not_connected')).toBe(true);
    expect(await connected(alice)).toBe(true);
  });
});
