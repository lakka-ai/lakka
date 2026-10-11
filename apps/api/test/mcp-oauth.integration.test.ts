import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  IssuedKey,
  McpConnectionView,
  McpConnectStartView,
  McpServerTestView,
  McpServerView,
  WorkspaceView,
} from '@lakka/contracts';
import { startMcpHttpServer } from '../../../test/integration/mcp-http-server.ts';
import type { McpHttpFixture } from '../../../test/integration/mcp-http-server.ts';
import { startOAuthFixture } from '../../../test/integration/oauth-fixture.ts';
import type { OAuthFixture } from '../../../test/integration/oauth-fixture.ts';
import { allowMcpOrigins, as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Per-user credentials for MCP servers through OAuth (TL-2, ADR 0068), against a fixture
 * authorization server and an MCP server that accepts only its tokens and reports whose they
 * are: each person authorizes for themselves and the server sees them, not a shared account.
 */

const CALLBACK = '/api/mcp/oauth/callback';

let t: TestApp;
let root: SignedInUser;
let alice: SignedInUser;
let bob: SignedInUser;
let outsider: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let as1: OAuthFixture;
let mcp1: McpHttpFixture;

const suffix = () => randomBytes(3).toString('hex');
const servers = (ws = alpha) => `/api/workspaces/${ws.id}/mcp-servers`;
const connections = (ws = alpha) => `/api/workspaces/${ws.id}/mcp-connections`;

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${suffix()}`,
  });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

/** An OAuth server; both fixtures are on loopback, which takes an instance admin's server. */
async function oauthServer(url: string, extra: object = {}): Promise<McpServerView> {
  const res = await as(t, root).post(servers(), {
    transport: 'streamable_http',
    name: `oauth-${suffix()}`,
    url,
    authMode: 'oauth',
    ...extra,
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { server: McpServerView }).server;
}

/** Starts connecting, and returns the authorization URL. */
async function start(user: SignedInUser, server: McpServerView) {
  return as(t, user).post(`${connections()}/${server.id}`, {});
}

/** Plays the person's browser: authorizes as `name` and follows the redirect back. */
async function authorize(user: SignedInUser, server: McpServerView, name: string) {
  const started = await start(user, server);
  expect(started.statusCode).toBe(200);
  const { authorizationUrl } = started.json() as McpConnectStartView;
  const res = await fetch(`${authorizationUrl}&test_user=${name}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get('location') ?? '');
  expect(`${back.origin}${back.pathname}`).toBe(`${PUBLIC_URL}${CALLBACK}`);
  return { url: new URL(authorizationUrl), callback: `${CALLBACK}${back.search}` };
}

async function callback(path: string, user: SignedInUser | null) {
  const res = await t.app.inject({
    method: 'GET',
    url: path,
    headers: user === null ? {} : { cookie: user.cookie },
  });
  expect(res.statusCode).toBe(302);
  return String(res.headers.location);
}

async function connect(user: SignedInUser, server: McpServerView, name: string) {
  const { callback: path } = await authorize(user, server, name);
  expect(await callback(path, user)).toBe(
    `/workspaces/${alpha.id}/connections?result=connected&server=${server.name}`,
  );
}

async function testMine(user: SignedInUser, server: McpServerView) {
  const res = await as(t, user).post(`${connections()}/${server.id}/test`, {});
  expect(res.statusCode).toBe(200);
  return res.json() as McpServerTestView;
}

async function mine(user: SignedInUser): Promise<McpConnectionView[]> {
  return ((await as(t, user).get(connections())).json() as { connections: McpConnectionView[] })
    .connections;
}

beforeAll(async () => {
  as1 = await startOAuthFixture();
  mcp1 = await startMcpHttpServer({ oauth: as1 });
  t = await createTestApp({ mcpAllowedOrigins: [mcp1.url, as1.issuer] });
  [root, alice, bob, outsider] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Alice'),
    signedInUser(t, 'Bob'),
    signedInUser(t, 'Outsider'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  for (const user of [alice, bob]) {
    await as(t, root).put(`/api/workspaces/${alpha.id}/members/${user.principal.id}`, {
      role: 'member',
    });
  }
  await as(t, root).put(`/api/workspaces/${bravo.id}/members/${outsider.principal.id}`, {
    role: 'member',
  });
});

afterAll(async () => {
  await mcp1.close();
  await as1.close();
  await t.close();
});

describe('each person connects their own account (TL-2)', () => {
  it('TL-2: two people authorize separately, and the server sees each of them, not a shared account', async () => {
    const server = await oauthServer(mcp1.url);
    expect(server).toMatchObject({ authMode: 'oauth', oauthClient: null });
    // Nobody has connected: the server lists them as not connected, and cannot be used.
    expect((await mine(alice)).find((c) => c.serverId === server.id)?.connected).toBe(false);
    expect((await testMine(alice, server)).status).toBe('not_connected');

    const { url } = await authorize(alice, server, 'alice').then(async (flow) => {
      await callback(flow.callback, alice);
      return flow;
    });
    // PKCE with S256, a state, and the server as the resource the token is for (RFC 8707).
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{40,}$/);
    expect(url.searchParams.get('resource')).toBe(mcp1.url);
    expect(url.searchParams.get('scope')).toBe('tools:read');
    await connect(bob, server, 'bob');

    expect((await testMine(alice, server)).status).toBe('ok');
    expect(mcp1.users.at(-1)).toBe('alice');
    expect((await testMine(bob, server)).status).toBe('ok');
    expect(mcp1.users.at(-1)).toBe('bob');
    expect(as1.resources).toContain(mcp1.url);
    // One dynamic registration, reused by everyone after.
    expect(as1.counts.registrations).toBe(1);
    const after = (await as(t, root).get(`${servers()}/${server.id}`)).json() as {
      server: McpServerView;
    };
    expect(after.server.oauthClient).toBe('registered');
    expect((await mine(alice)).find((c) => c.serverId === server.id)).toMatchObject({
      connected: true,
    });
  });

  it('an authorization completes once, only for the person who started it, and only when signed in', async () => {
    const server = await oauthServer(mcp1.url);
    const flow = await authorize(alice, server, 'alice');
    // Bob cannot finish Alice's authorization, and that spends it.
    expect(await callback(flow.callback, bob)).toBe('/?mcp=failed');
    expect(await callback(flow.callback, alice)).toBe('/?mcp=failed');
    const again = await authorize(alice, server, 'alice');
    expect(await callback(again.callback, null)).toBe('/?mcp=failed');
    // A refusal at the authorization server, or a malformed callback, lands on an explanation.
    expect(await callback(`${CALLBACK}?error=access_denied&state=x`, alice)).toBe('/?mcp=denied');
    expect(await callback(`${CALLBACK}?code=x`, alice)).toBe('/?mcp=failed');
    expect((await mine(alice)).find((c) => c.serverId === server.id)?.connected).toBe(false);
  });

  it('a token about to expire is refreshed once, under a lock, and a refused refresh means connecting again', async () => {
    // Tokens for 30 seconds are always inside the refresh margin, so every use refreshes.
    const shortAs = await startOAuthFixture({ accessTtlSeconds: 30 });
    const shortMcp = await startMcpHttpServer({ oauth: shortAs });
    await allowMcpOrigins(t, shortMcp.url, shortAs.issuer);
    try {
      const server = await oauthServer(shortMcp.url);
      await connect(alice, server, 'alice');
      const [first, second] = await Promise.all([testMine(alice, server), testMine(alice, server)]);
      expect([first.status, second.status]).toEqual(['ok', 'ok']);
      // Two uses at once, one refresh each in turn: the rotating refresh token was never spent twice.
      expect(shortAs.counts.refreshes).toBe(2);
      expect(shortMcp.users.every((u) => u === 'alice')).toBe(true);

      shortAs.forgetRefreshTokens();
      expect((await testMine(alice, server)).status).toBe('not_connected');
      expect((await mine(alice)).find((c) => c.serverId === server.id)?.connected).toBe(false);
    } finally {
      await shortMcp.close();
      await shortAs.close();
    }
  });

  it('a person disconnects, and their credential is gone', async () => {
    const server = await oauthServer(mcp1.url);
    await connect(alice, server, 'alice');
    expect((await as(t, alice).delete(`${connections()}/${server.id}`)).statusCode).toBe(204);
    expect((await testMine(alice, server)).status).toBe('not_connected');
    expect((await as(t, alice).delete(`${connections()}/${server.id}`)).statusCode).toBe(404);
  });
});

describe('authorization servers without dynamic registration (ADR 0068)', () => {
  it('TL-2: an admin enters the client, write-only, and then people connect with it', async () => {
    const closedAs = await startOAuthFixture({ registration: false });
    const closedMcp = await startMcpHttpServer({ oauth: closedAs });
    await allowMcpOrigins(t, closedMcp.url, closedAs.issuer);
    try {
      const server = await oauthServer(closedMcp.url);
      const refused = await start(alice, server);
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: { code: 'mcp_oauth_client_required' } });

      const secret = `client-secret-${suffix()}`;
      closedAs.addClient('lakka-app', secret, `${PUBLIC_URL}${CALLBACK}`);
      const set = await as(t, root).put(`${servers()}/${server.id}/oauth-client`, {
        clientId: 'lakka-app',
        clientSecret: secret,
      });
      expect(set.statusCode).toBe(200);
      expect(set.body).not.toContain(secret);
      expect((set.json() as { server: McpServerView }).server.oauthClient).toBe('admin');
      await connect(alice, server, 'alice');
      expect((await testMine(alice, server)).status).toBe('ok');
      expect(closedMcp.users.at(-1)).toBe('alice');
      expect(t.logs.join('\n')).not.toContain(secret);
    } finally {
      await closedMcp.close();
      await closedAs.close();
    }
  });
});

describe("what happens to people's tokens (TL-2, ID-5)", () => {
  it("an admin's test uses the admin's own connection", async () => {
    const server = await oauthServer(mcp1.url);
    await as(t, root).put(`/api/workspaces/${alpha.id}/members/${root.principal.id}`, {
      role: 'admin',
    });
    const test = async () =>
      ((await as(t, root).post(`${servers()}/${server.id}/test`, {})).json() as McpServerTestView)
        .status;
    // Not connected is not a finding about the server, so nothing is recorded for it.
    expect(await test()).toBe('not_connected');
    const untested = await as(t, root).get(`${servers()}/${server.id}`);
    expect((untested.json() as { server: McpServerView }).server.lastTestStatus).toBeNull();
    await connect(root, server, 'root');
    expect(await test()).toBe('ok');
    expect(mcp1.users.at(-1)).toBe('root');
  });

  it("changing the URL or leaving OAuth forgets everyone's tokens; so does leaving the workspace", async () => {
    const server = await oauthServer(mcp1.url);
    await connect(alice, server, 'alice');
    await connect(bob, server, 'bob');
    const count = async () =>
      (await t.pool.query('select 1 from mcp_credentials where mcp_server_id = $1', [server.id]))
        .rowCount;
    expect(await count()).toBe(2);
    await as(t, root).delete(`/api/workspaces/${alpha.id}/members/${bob.principal.id}`);
    expect(await count()).toBe(1);
    await as(t, root).put(`/api/workspaces/${alpha.id}/members/${bob.principal.id}`, {
      role: 'member',
    });
    await as(t, root).patch(`${servers()}/${server.id}`, { authMode: 'none' });
    expect(await count()).toBe(0);
  });

  it('ID-5: keys cannot connect accounts; another workspace cannot reach this server', async () => {
    const server = await oauthServer(mcp1.url);
    const key = (
      await as(t, alice).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Script' })
    ).json() as IssuedKey;
    const res = await t.app.inject({
      method: 'POST',
      url: `${connections()}/${server.id}`,
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.statusCode).toBe(403);
    expect((await as(t, outsider).post(`${connections()}/${server.id}`, {})).statusCode).toBe(404);
    expect((await as(t, outsider).post(`${connections(bravo)}/${server.id}`, {})).statusCode).toBe(
      404,
    );
  });

  it('NF-S5, PR-3: no token reaches a response or the logs', async () => {
    const listed = await as(t, alice).get(connections());
    const logs = t.logs.join('\n');
    for (const token of as1.issued) {
      expect(listed.body).not.toContain(token);
      expect(logs).not.toContain(token);
    }
    expect(as1.issued.length).toBeGreaterThan(0);
  });
});
