import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AvailableToolView,
  IssuedKey,
  McpServerView,
  McpToolSyncView,
  WorkspaceToolView,
  WorkspaceView,
} from '@lakka/contracts';
import { policySnapshots } from '@lakka/core';
import { startMcpHttpServer } from '../../../test/integration/mcp-http-server.ts';
import type { McpHttpFixture } from '../../../test/integration/mcp-http-server.ts';
import { startOAuthFixture } from '../../../test/integration/oauth-fixture.ts';
import type { OAuthFixture } from '../../../test/integration/oauth-fixture.ts';
import { allowMcpOrigins, as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The allowlist (TL-3, TL-4, ADR 0069): syncing a server's tools, the admin's decisions, the
 * policy snapshot requests read, and which tools a person can use now.
 */

const TOKEN = 'shared-token-0123456789';

let t: TestApp;
let root: SignedInUser;
let member: SignedInUser;
let outsider: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let open: McpHttpFixture;
let guarded: McpHttpFixture;
let authServer: OAuthFixture;
let protectedMcp: McpHttpFixture;

const suffix = () => randomBytes(3).toString('hex');
const base = (ws = alpha) => `/api/workspaces/${ws.id}`;

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${suffix()}`,
  });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function server(url: string, authMode: 'none' | 'shared' | 'oauth'): Promise<McpServerView> {
  const res = await as(t, root).post(`${base()}/mcp-servers`, {
    transport: 'streamable_http',
    name: `srv-${suffix()}`,
    url,
    authMode,
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { server: McpServerView }).server;
}

async function sync(s: McpServerView, user = root): Promise<McpToolSyncView> {
  const res = await as(t, user).post(`${base()}/mcp-servers/${s.id}/tools/sync`, {});
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json() as McpToolSyncView;
}

const byName = (tools: WorkspaceToolView[], name: string) => {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

async function change(tool: WorkspaceToolView, body: object) {
  return as(t, root).patch(`${base()}/tools/${tool.id}`, body);
}

/** The tools the person can use now; blocked ones are listed too, with why (ADR 0096). */
async function available(user: SignedInUser): Promise<string[]> {
  return (await listed(user))
    .filter((tool) => tool.blockedBy === null)
    .map((tool) => tool.modelName);
}

async function listed(user: SignedInUser): Promise<AvailableToolView[]> {
  const res = await as(t, user).get(`${base()}/tools/available`);
  expect(res.statusCode).toBe(200);
  return (res.json() as { tools: AvailableToolView[] }).tools;
}

async function version(): Promise<number> {
  const { rows } = await t.pool.query<{ v: number }>(
    'select policy_version as v from workspaces where id = $1',
    [alpha.id],
  );
  return rows[0]?.v ?? 0;
}

beforeAll(async () => {
  authServer = await startOAuthFixture();
  [open, guarded, protectedMcp] = await Promise.all([
    startMcpHttpServer(),
    startMcpHttpServer({ token: TOKEN }),
    startMcpHttpServer({ oauth: authServer }),
  ]);
  t = await createTestApp({
    mcpAllowedOrigins: [open.url, guarded.url, protectedMcp.url, authServer.issuer],
  });
  [root, member, outsider] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Member'),
    signedInUser(t, 'Outsider'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  await as(t, root).put(`${base()}/members/${member.principal.id}`, { role: 'member' });
  await as(t, root).put(`${base(bravo)}/members/${outsider.principal.id}`, { role: 'admin' });
});

afterAll(async () => {
  await Promise.all([open.close(), guarded.close(), protectedMcp.close()]);
  await authServer.close();
  await t.close();
});

describe('syncing and deciding (TL-3, TL-4)', () => {
  it('TL-3, TL-4, H2: synced tools start off the allowlist, asking first unless read-only', async () => {
    const s = await server(open.url, 'none');
    const before = await version();
    const result = await sync(s);
    expect(result).toMatchObject({ added: 3, updated: 0, removed: 0 });
    expect(await version()).toBeGreaterThan(before);
    const echo = byName(result.tools, 'echo');
    expect(echo).toMatchObject({
      modelName: `${s.name}__echo`,
      enabled: false,
      approvalRequired: false,
      unusable: null,
      description: 'Returns the text it is given.',
      annotations: { readOnlyHint: true },
    });
    expect(byName(result.tools, 'delete')).toMatchObject({
      enabled: false,
      approvalRequired: true,
    });
    expect(await available(member)).toEqual([]);
  });

  it('TL-3: an enabled tool reaches the policy snapshot with its stored definition', async () => {
    const s = await server(open.url, 'none');
    const echo = byName((await sync(s)).tools, 'echo');
    const before = await version();
    const res = await change(echo, { enabled: true });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBeGreaterThan(before);
    const snapshot = await policySnapshots({ db: t.db }).get(alpha.id);
    expect(snapshot?.tools.find((tool) => tool.id === echo.id)).toMatchObject({
      modelName: `${s.name}__echo`,
      serverName: s.name,
      approvalRequired: false,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    });
    expect(await available(member)).toContain(`${s.name}__echo`);

    // TL-4: an admin may make even a read-only tool ask first.
    await change(echo, { approvalRequired: true });
    const after = await policySnapshots({ db: t.db }).get(alpha.id);
    expect(after?.tools.find((tool) => tool.id === echo.id)?.approvalRequired).toBe(true);
    await change(echo, { enabled: false });
    expect(await available(member)).not.toContain(`${s.name}__echo`);
  });

  it("a later sync takes the server's new definitions, keeps the admin's choices, and drops what is gone", async () => {
    const changing = await startMcpHttpServer();
    await allowMcpOrigins(t, changing.url);
    try {
      const s = await server(changing.url, 'none');
      const first = await sync(s);
      await change(byName(first.tools, 'echo'), { enabled: true, approvalRequired: true });
      await change(byName(first.tools, 'delete'), { enabled: true });

      changing.setVariant('changed');
      const second = await sync(s);
      expect(second).toMatchObject({ added: 1, updated: 2, removed: 1 });
      expect(byName(second.tools, 'echo')).toMatchObject({
        description: 'Returns the text, unchanged.',
        enabled: true,
        approvalRequired: true,
      });
      expect(second.tools.map((tool) => tool.name)).not.toContain('delete');
      // H1: a name models cannot be given is listed, and cannot be enabled.
      const dotted = byName(second.tools, 'report.summary');
      expect(dotted).toMatchObject({ modelName: null, unusable: 'name', enabled: false });
      const refused = await change(dotted, { enabled: true });
      expect(refused.statusCode).toBe(400);
    } finally {
      await changing.close();
    }
  });

  it('deleting a server removes its tools from the snapshot', async () => {
    const s = await server(open.url, 'none');
    const echo = byName((await sync(s)).tools, 'echo');
    await change(echo, { enabled: true });
    expect(await available(member)).toContain(`${s.name}__echo`);
    await as(t, root).delete(`${base()}/mcp-servers/${s.id}`);
    expect(await available(member)).not.toContain(`${s.name}__echo`);
  });
});

describe('which tools a person can use now (pipeline stage 6, TL-2)', () => {
  it('TL-2: a shared-credential server needs its credential set; an OAuth server needs the person connected', async () => {
    const shared = await server(guarded.url, 'shared');
    // No credential, nothing to sync with.
    expect(
      (await as(t, root).post(`${base()}/mcp-servers/${shared.id}/tools/sync`, {})).statusCode,
    ).toBe(400);
    await as(t, root).put(`${base()}/mcp-servers/${shared.id}/credential`, { secret: TOKEN });
    await change(byName((await sync(shared)).tools, 'echo'), { enabled: true });
    expect(await available(member)).toContain(`${shared.name}__echo`);
    await as(t, root).delete(`${base()}/mcp-servers/${shared.id}/credential`);
    expect(await available(member)).not.toContain(`${shared.name}__echo`);
    // Still listed, saying why it cannot be used yet.
    expect(
      (await listed(member)).find((tool) => tool.modelName === `${shared.name}__echo`),
    ).toMatchObject({
      name: 'echo',
      blockedBy: 'no_credential',
    });

    const oauth = await server(protectedMcp.url, 'oauth');
    // The admin syncs with their own connection.
    await as(t, root).put(`${base()}/members/${root.principal.id}`, { role: 'admin' });
    await connect(root, oauth, 'root');
    await change(byName((await sync(oauth)).tools, 'echo'), { enabled: true });
    expect(await available(member)).not.toContain(`${oauth.name}__echo`);
    expect(
      (await listed(member)).find((tool) => tool.modelName === `${oauth.name}__echo`),
    ).toMatchObject({
      blockedBy: 'not_connected',
      standingApproval: false,
    });
    await connect(member, oauth, 'member');
    expect(await available(member)).toContain(`${oauth.name}__echo`);

    // A key sees what its owner can use (invariant 2).
    const key = (
      await as(t, member).post(`${base()}/keys`, { name: 'Script' })
    ).json() as IssuedKey;
    const res = await t.app.inject({
      method: 'GET',
      url: `${base()}/tools/available`,
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(
      (res.json() as { tools: AvailableToolView[] }).tools.map((tool) => tool.modelName),
    ).toContain(`${oauth.name}__echo`);
  });
});

describe('who decides (TL-3, AC 16)', () => {
  it('TL-3: members use tools but do not see the admin list or change it; other workspaces see nothing', async () => {
    const s = await server(open.url, 'none');
    const echo = byName((await sync(s)).tools, 'echo');
    expect((await as(t, member).get(`${base()}/tools`)).statusCode).toBe(403);
    expect(
      (await as(t, member).patch(`${base()}/tools/${echo.id}`, { enabled: true })).statusCode,
    ).toBe(403);
    expect(
      (await as(t, member).post(`${base()}/mcp-servers/${s.id}/tools/sync`, {})).statusCode,
    ).toBe(403);
    for (const res of [
      await as(t, outsider).get(`${base()}/tools`),
      await as(t, outsider).get(`${base()}/tools/available`),
      await as(t, outsider).patch(`${base()}/tools/${echo.id}`, { enabled: true }),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    // Even as an admin of their own workspace, this workspace's tool id is not found there.
    expect(
      (await as(t, outsider).patch(`${base(bravo)}/tools/${echo.id}`, { enabled: true }))
        .statusCode,
    ).toBe(404);
  });
});

/** Connects a person's account to the OAuth fixture, as mcp-oauth.integration.test.ts does. */
async function connect(user: SignedInUser, s: McpServerView, name: string): Promise<void> {
  const started = await as(t, user).post(`${base()}/mcp-connections/${s.id}`, {});
  const { authorizationUrl } = started.json() as { authorizationUrl: string };
  const res = await fetch(`${authorizationUrl}&test_user=${name}`, { redirect: 'manual' });
  const back = new URL(res.headers.get('location') ?? '');
  const done = await t.app.inject({
    method: 'GET',
    url: `${back.pathname}${back.search}`,
    headers: { cookie: user.cookie },
  });
  expect(String(done.headers.location)).toContain('result=connected');
}

describe('what the Tools and Your connections pages are told (ADR 0096)', () => {
  it('TL-1: a server has a name for people, its own or one made from its slug', async () => {
    const named = (
      await as(t, root).post(`${base()}/mcp-servers`, {
        transport: 'streamable_http',
        name: `gh-${suffix()}`,
        displayName: 'GitHub',
        url: open.url,
        authMode: 'none',
      })
    ).json() as { server: McpServerView };
    expect(named.server).toMatchObject({ displayName: 'GitHub', displayNameSet: true });
    const tools = (await sync(named.server)).tools;
    expect(tools[0]?.serverDisplayName).toBe('GitHub');
    const reset = await as(t, root).patch(`${base()}/mcp-servers/${named.server.id}`, {
      displayName: null,
    });
    expect((reset.json() as { server: McpServerView }).server).toMatchObject({
      displayName: `Gh ${named.server.name.slice(3)}`,
      displayNameSet: false,
    });
  });

  it('TL-1: a server keeps when its tools were last synced, and why that failed', async () => {
    const fine = await server(open.url, 'none');
    expect(fine.lastSync).toBeNull();
    await sync(fine);
    const synced = (await as(t, root).get(`${base()}/mcp-servers/${fine.id}`)).json() as {
      server: McpServerView;
    };
    expect(synced.server.lastSync).toMatchObject({ error: null });
    const locked = await server(guarded.url, 'shared');
    expect(
      (await as(t, root).post(`${base()}/mcp-servers/${locked.id}/tools/sync`, {})).statusCode,
    ).toBe(400);
    const failed = (await as(t, root).get(`${base()}/mcp-servers/${locked.id}`)).json() as {
      server: McpServerView;
    };
    expect(failed.server.lastSync).toMatchObject({ error: 'no_credential' });
  });

  it('TL-2: everyone sees every server and how it signs in, but not its address', async () => {
    const res = await as(t, member).get(`${base()}/mcp-connections`);
    expect(res.statusCode).toBe(200);
    const { connections } = res.json() as {
      connections: { authMode: string; hasSharedCredential: boolean; displayName: string }[];
    };
    expect(new Set(connections.map((c) => c.authMode))).toEqual(
      new Set(['none', 'shared', 'oauth']),
    );
    expect(connections.every((c) => c.displayName.length > 0)).toBe(true);
    expect(res.body).not.toContain(open.url);
    expect(res.body).not.toContain(guarded.url);
  });
});
