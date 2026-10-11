import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerTestView, McpServerView, WorkspaceView } from '@lakka/contracts';
import { startMcpHttpServer } from '../../../test/integration/mcp-http-server.ts';
import type { McpHttpFixture } from '../../../test/integration/mcp-http-server.ts';
import { allowMcpOrigins, as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * A workspace's MCP servers (TL-1, ADR 0066 Q2, ADR 0067) against real Postgres and fixture
 * servers built with the official MCP server package: who may add which kind, where a server may
 * point, write-only shared credentials, and isolation between workspaces.
 */

const STDIO_SERVER = fileURLToPath(
  new URL('../../../test/integration/mcp-stdio-server.ts', import.meta.url),
);
const TOKEN = 'mcp-shared-token-0123456789';

let t: TestApp;
let root: SignedInUser;
let wsAdmin: SignedInUser;
let member: SignedInUser;
let outsider: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let open: McpHttpFixture;
let guarded: McpHttpFixture;
let listed: McpHttpFixture;

const servers = (ws = alpha) => `/api/workspaces/${ws.id}/mcp-servers`;
const suffix = () => randomBytes(3).toString('hex');

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${suffix()}`,
  });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function add(user: SignedInUser, body: object, ws = alpha) {
  return as(t, user).post(servers(ws), body);
}

async function added(user: SignedInUser, body: object, ws = alpha): Promise<McpServerView> {
  const res = await add(user, body, ws);
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { server: McpServerView }).server;
}

async function test(user: SignedInUser, server: McpServerView, ws = alpha) {
  const res = await as(t, user).post(`${servers(ws)}/${server.id}/test`, {});
  expect(res.statusCode).toBe(200);
  return res.json() as McpServerTestView;
}

beforeAll(async () => {
  [open, guarded, listed] = await Promise.all([
    startMcpHttpServer(),
    startMcpHttpServer({ token: TOKEN }),
    startMcpHttpServer(),
  ]);
  t = await createTestApp({
    mcpPrivateOrigins: [new URL(listed.url).origin],
    mcpAllowedOrigins: [open.url, guarded.url, 'https://example.invalid'],
  });
  [root, wsAdmin, member, outsider] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Member'),
    signedInUser(t, 'Outsider'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  for (const [user, role] of [
    [wsAdmin, 'admin'],
    [member, 'member'],
  ] as const) {
    await as(t, root).put(`/api/workspaces/${alpha.id}/members/${user.principal.id}`, { role });
  }
  await as(t, root).put(`/api/workspaces/${bravo.id}/members/${outsider.principal.id}`, {
    role: 'admin',
  });
});

afterAll(async () => {
  await Promise.all([open.close(), guarded.close(), listed.close()]);
  await t.close();
});

describe('adding servers (TL-1, ADR 0066 Q2)', () => {
  it('TL-1: an instance admin adds a Streamable HTTP server anywhere, and its tools are listed', async () => {
    const server = await added(root, {
      transport: 'streamable_http',
      name: `local-${suffix()}`,
      url: open.url,
      authMode: 'none',
    });
    expect(server).toMatchObject({
      allowPrivate: true,
      hasSharedCredential: false,
      lastTestStatus: null,
    });
    const result = await test(root, server);
    expect(result.status).toBe('ok');
    expect(result.tools.map((tool) => tool.name).toSorted()).toEqual(['delete', 'echo', 'whoami']);
    expect(result.tools.find((tool) => tool.name === 'echo')).toMatchObject({
      title: 'Echo',
      description: 'Returns the text it is given.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      annotations: { readOnlyHint: true, destructiveHint: null },
    });
    const after = (await as(t, root).get(`${servers()}/${server.id}`)).json() as {
      server: McpServerView;
    };
    expect(after.server.lastTestStatus).toBe('ok');
  });

  it('TL-1, Q2: an instance admin adds a stdio server, whose command runs with only the credential it is given', async () => {
    const plain = await added(root, {
      transport: 'stdio',
      name: `stdio-${suffix()}`,
      command: process.execPath,
      args: [STDIO_SERVER],
      authMode: 'none',
    });
    expect((await test(root, plain)).tools.map((tool) => tool.name)).toContain('echo');

    const shared = await added(root, {
      transport: 'stdio',
      name: `stdio-shared-${suffix()}`,
      command: process.execPath,
      args: [STDIO_SERVER],
      authMode: 'shared',
      credentialEnv: 'FIXTURE_TOKEN',
    });
    // No credential yet: nothing to connect with, and it says so.
    expect((await test(root, shared)).status).toBe('no_credential');
    await as(t, root).put(`${servers()}/${shared.id}/credential`, { secret: TOKEN });
    expect((await test(root, shared)).status).toBe('ok');
  });

  it('Q2: a workspace admin may not add a stdio server, or change one', async () => {
    const res = await add(wsAdmin, {
      transport: 'stdio',
      name: `stdio-${suffix()}`,
      command: 'node',
      authMode: 'none',
    });
    expect(res.statusCode).toBe(403);
    const theirs = await added(root, {
      transport: 'stdio',
      name: `stdio-${suffix()}`,
      command: process.execPath,
      args: [STDIO_SERVER],
      authMode: 'none',
    });
    expect(
      (await as(t, wsAdmin).patch(`${servers()}/${theirs.id}`, { args: ['-e', '1'] })).statusCode,
    ).toBe(403);
    expect((await as(t, wsAdmin).delete(`${servers()}/${theirs.id}`)).statusCode).toBe(403);
  });

  it('Q2: a workspace admin adds only public https servers, unless the operator listed the origin', async () => {
    for (const url of [
      'http://example.com/mcp',
      'https://127.0.0.1/mcp',
      'https://localhost/mcp',
      open.url,
    ]) {
      const res = await add(wsAdmin, {
        transport: 'streamable_http',
        name: `x-${suffix()}`,
        url,
        authMode: 'none',
      });
      expect(res.statusCode).toBe(400);
    }
    const allowed = await added(wsAdmin, {
      transport: 'streamable_http',
      name: `listed-${suffix()}`,
      url: listed.url,
      authMode: 'none',
    });
    expect(allowed.allowPrivate).toBe(true);
    expect((await test(wsAdmin, allowed)).status).toBe('ok');
  });

  it('Q2: a public-only server that resolves to a private address is not connected to', async () => {
    const server = await added(wsAdmin, {
      transport: 'streamable_http',
      name: `public-${suffix()}`,
      url: 'https://example.invalid/mcp',
      authMode: 'none',
    });
    expect(server.allowPrivate).toBe(false);
    // Pointed later at a name that resolves to loopback, by whoever: still public-only, even
    // with that origin listed (NF-S4).
    const loopback = `http://localhost.:${new URL(open.url).port}/mcp`;
    await allowMcpOrigins(t, loopback);
    await t.pool.query('update mcp_servers set url = $1 where id = $2', [loopback, server.id]);
    const before = open.authorizations.length;
    expect((await test(wsAdmin, server)).status).toBe('unreachable');
    // Refused before connecting: the fixture on loopback never saw a request.
    expect(open.authorizations.length).toBe(before);
  });

  it('names are unique in a workspace, and bodies are checked', async () => {
    const name = `dup-${suffix()}`;
    await added(root, { transport: 'streamable_http', name, url: open.url, authMode: 'none' });
    const again = await add(root, {
      transport: 'streamable_http',
      name,
      url: open.url,
      authMode: 'none',
    });
    expect(again.statusCode).toBe(409);
    for (const body of [
      { transport: 'streamable_http', name: 'Not Valid', url: open.url, authMode: 'none' },
      { transport: 'streamable_http', name: `a-${suffix()}`, url: 'ftp://x/mcp', authMode: 'none' },
      { transport: 'stdio', name: `a-${suffix()}`, command: 'node', authMode: 'shared' },
      { transport: 'stdio', name: `a-${suffix()}`, command: 'node', authMode: 'oauth' },
    ]) {
      expect((await add(root, body)).statusCode).toBe(400);
    }
  });
});

describe('shared credentials (TL-2, PR-3)', () => {
  it('TL-2, PR-3: a shared credential is sent as a bearer token and never returned', async () => {
    // The fixture is on loopback, which only an instance admin's server may reach.
    const server = await added(root, {
      transport: 'streamable_http',
      name: `guarded-${suffix()}`,
      url: guarded.url,
      authMode: 'shared',
    });
    expect((await test(root, server)).status).toBe('no_credential');
    const set = await as(t, root).put(`${servers()}/${server.id}/credential`, { secret: TOKEN });
    expect(set.statusCode).toBe(200);
    expect(set.body).not.toContain(TOKEN);
    expect((set.json() as { server: McpServerView }).server.hasSharedCredential).toBe(true);
    expect((await test(root, server)).status).toBe('ok');
    expect(guarded.authorizations).toContain(`Bearer ${TOKEN}`);

    const read = await as(t, root).get(servers());
    expect(read.body).not.toContain(TOKEN);
    const stored = await t.pool.query<{ secret: string }>(
      'select secret from mcp_credentials where mcp_server_id = $1',
      [server.id],
    );
    expect(stored.rows[0]?.secret).not.toContain(TOKEN);

    await as(t, root).put(`${servers()}/${server.id}/credential`, { secret: 'wrong' });
    expect((await test(root, server)).status).toBe('auth_failed');
    expect((await as(t, root).delete(`${servers()}/${server.id}/credential`)).statusCode).toBe(204);
    expect((await as(t, root).delete(`${servers()}/${server.id}/credential`)).statusCode).toBe(404);
  });

  it('deleting a server deletes its credentials', async () => {
    const server = await added(root, {
      transport: 'streamable_http',
      name: `gone-${suffix()}`,
      url: guarded.url,
      authMode: 'shared',
    });
    await as(t, root).put(`${servers()}/${server.id}/credential`, { secret: TOKEN });
    expect((await as(t, root).delete(`${servers()}/${server.id}`)).statusCode).toBe(204);
    const left = await t.pool.query('select 1 from mcp_credentials where mcp_server_id = $1', [
      server.id,
    ]);
    expect(left.rowCount).toBe(0);
  });
});

describe('who sees and manages servers (TL-3, AC 16)', () => {
  it('TL-3: members do not manage or list servers; keys cannot either', async () => {
    expect((await as(t, member).get(servers())).statusCode).toBe(403);
    expect(
      (
        await add(member, {
          transport: 'streamable_http',
          name: `m-${suffix()}`,
          url: 'https://example.com/mcp',
          authMode: 'none',
        })
      ).statusCode,
    ).toBe(403);
    const key = (
      await as(t, wsAdmin).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Script' })
    ).json() as {
      secret: string;
    };
    const res = await t.app.inject({
      method: 'GET',
      url: servers(),
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('AC 16: another workspace cannot see, test, change or delete these servers', async () => {
    const server = await added(root, {
      transport: 'streamable_http',
      name: `private-${suffix()}`,
      url: open.url,
      authMode: 'none',
    });
    for (const res of [
      await as(t, outsider).get(servers()),
      await as(t, outsider).post(`${servers()}/${server.id}/test`, {}),
      await as(t, outsider).patch(`${servers()}/${server.id}`, { name: 'taken' }),
      await as(t, outsider).delete(`${servers()}/${server.id}`),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    // Their own workspace's routes with this workspace's server id find nothing either.
    expect((await as(t, outsider).get(`${servers(bravo)}/${server.id}`)).statusCode).toBe(404);
  });

  it('NF-S5: no credential reaches the logs', () => {
    expect(t.logs.join('\n')).not.toContain(TOKEN);
  });
});
