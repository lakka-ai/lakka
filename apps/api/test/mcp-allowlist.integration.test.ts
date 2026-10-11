import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  McpAllowedOriginsView,
  McpServerTestView,
  McpServerView,
  McpToolSyncView,
  WorkspaceView,
} from '@lakka/contracts';
import {
  createLogger,
  dispatchToolCall,
  inProcessExecutor,
  noEvents,
  policySnapshots,
  resolveTools,
} from '@lakka/core';
import type { ToolDispatchContext, ToolDispatchRequest } from '@lakka/core';
import { listToolInvocationsForRequest } from '@lakka/db';
import { startMcpHttpServer } from '../../../test/integration/mcp-http-server.ts';
import type { McpHttpFixture } from '../../../test/integration/mcp-http-server.ts';
import { startOAuthFixture } from '../../../test/integration/oauth-fixture.ts';
import type { OAuthFixture } from '../../../test/integration/oauth-fixture.ts';
import { allowMcpOrigins, as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The instance's allowlist of MCP origins (NF-S4, ADR 0117) against real Postgres and Valkey and
 * fixture servers: who changes it, what it refuses when a server is saved, and that every
 * connection reads it afresh, including the authorization servers an OAuth server names and the
 * tool calls the dispatch seam makes.
 */

const ORIGINS = '/api/admin/mcp-origins';
const PUBLIC_ORIGIN = 'https://tools.example.com';

let t: TestApp;
let root: SignedInUser;
let wsAdmin: SignedInUser;
let member: SignedInUser;
let alpha: WorkspaceView;
let open: McpHttpFixture;
const { logger } = createLogger({
  level: 'debug',
  service: 'allowlist-test',
  destination: { write: () => undefined },
});

const suffix = () => randomBytes(3).toString('hex');
const servers = () => `/api/workspaces/${alpha.id}/mcp-servers`;
const connections = () => `/api/workspaces/${alpha.id}/mcp-connections`;
const originOf = (url: string) => new URL(url).origin;

async function listed(): Promise<string[]> {
  const res = await as(t, root).get(ORIGINS);
  expect(res.statusCode).toBe(200);
  return (res.json() as { allowlist: McpAllowedOriginsView }).allowlist.origins.map(
    (o) => o.origin,
  );
}

async function added(user: SignedInUser, body: object): Promise<McpServerView> {
  const res = await as(t, user).post(servers(), body);
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { server: McpServerView }).server;
}

function context(): ToolDispatchContext {
  return {
    db: t.db,
    events: noEvents,
    mcpPrivateOrigins: [],
    publicUrl: PUBLIC_URL,
    executor: inProcessExecutor,
    logger,
  };
}

async function request(user: SignedInUser): Promise<ToolDispatchRequest> {
  const policy = await policySnapshots({ db: t.db }).get(alpha.id);
  if (policy === undefined) throw new Error('no policy');
  return {
    requestId: randomUUID(),
    workspaceId: alpha.id,
    principal: user.principal,
    conversationId: null,
    policy,
    offered: await resolveTools(context(), policy, user.principal),
    isApproved: async () => true,
    signal: new AbortController().signal,
  };
}

beforeAll(async () => {
  open = await startMcpHttpServer();
  t = await createTestApp({ mcpPrivateOrigins: ['http://10.0.0.5:8080'] });
  [root, wsAdmin, member] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Admin'),
    signedInUser(t, 'Member'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = (
    (
      await as(t, root).post('/api/workspaces', { name: 'Alpha', slug: `alpha-${suffix()}` })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  for (const [user, role] of [
    [wsAdmin, 'admin'],
    [member, 'member'],
  ] as const) {
    await as(t, root).put(`/api/workspaces/${alpha.id}/members/${user.principal.id}`, { role });
  }
});

afterAll(async () => {
  await open.close();
  await t.close();
});

describe('the allowlist itself (NF-S4)', () => {
  it('NF-S4: only instance admins see or change the allowlist; keys cannot either', async () => {
    for (const user of [wsAdmin, member]) {
      expect((await as(t, user).get(ORIGINS)).statusCode).toBe(403);
      expect((await as(t, user).post(ORIGINS, { origin: PUBLIC_ORIGIN })).statusCode).toBe(403);
      expect(
        (await as(t, user).delete(`${ORIGINS}?origin=${encodeURIComponent(PUBLIC_ORIGIN)}`))
          .statusCode,
      ).toBe(403);
    }
    const key = (
      (
        await as(t, wsAdmin).post(`/api/workspaces/${alpha.id}/keys`, { name: 'Script' })
      ).json() as {
        secret: string;
      }
    ).secret;
    const byKey = await t.app.inject({
      method: 'POST',
      url: ORIGINS,
      headers: { authorization: `Bearer ${key}` },
      payload: { origin: PUBLIC_ORIGIN },
    });
    expect(byKey.statusCode).toBe(403);
    expect(await listed()).not.toContain(PUBLIC_ORIGIN);
  });

  it('NF-S4: an instance admin lists exact origins, written one way, and removes them', async () => {
    const listing = await as(t, root).post(ORIGINS, { origin: 'HTTPS://Tools.Example.COM:443/' });
    expect(listing.statusCode).toBe(201);
    const view = (listing.json() as { allowlist: McpAllowedOriginsView }).allowlist;
    expect(view.origins).toContainEqual(
      expect.objectContaining({ origin: PUBLIC_ORIGIN, source: 'admin', addedBy: 'Root' }),
    );
    // The operator's private origins count as listed, and are shown as theirs.
    expect(view.configured).toEqual(['http://10.0.0.5:8080']);
    // Listing it again changes nothing.
    expect((await as(t, root).post(ORIGINS, { origin: PUBLIC_ORIGIN })).statusCode).toBe(200);
    // An address with a path, a query or credentials is not an origin; nor is anything else.
    for (const origin of [
      'https://tools.example.com/mcp',
      'https://tools.example.com?x=1',
      'https://user@tools.example.com',
      'ftp://tools.example.com',
      '*.example.com',
    ]) {
      expect((await as(t, root).post(ORIGINS, { origin })).statusCode).toBe(400);
    }
    const query = `?origin=${encodeURIComponent(PUBLIC_ORIGIN)}`;
    expect((await as(t, root).delete(`${ORIGINS}${query}`)).statusCode).toBe(204);
    expect((await as(t, root).delete(`${ORIGINS}${query}`)).statusCode).toBe(404);
    expect(await listed()).not.toContain(PUBLIC_ORIGIN);
  });
});

describe('saving a server (NF-S4)', () => {
  it('NF-S4: a workspace admin cannot add a server at an unlisted public origin', async () => {
    const origin = `https://mcp-${suffix()}.example.com`;
    const body = {
      transport: 'streamable_http',
      name: `pub-${suffix()}`,
      url: `${origin}/mcp`,
      authMode: 'none',
    };
    const refused = await as(t, wsAdmin).post(servers(), body);
    expect(refused.statusCode).toBe(422);
    // Says which origin, so an instance admin knows what to list.
    expect((refused.json() as ApiErrorBody).error).toMatchObject({
      code: 'mcp_origin_not_allowed',
      details: { origin },
    });
    await as(t, root).post(ORIGINS, { origin });
    expect((await as(t, wsAdmin).post(servers(), body)).statusCode).toBe(201);
  });

  it("NF-S4: an instance admin's server needs a listed origin too, and so does a new URL", async () => {
    const body = {
      transport: 'streamable_http',
      name: `local-${suffix()}`,
      url: open.url,
      authMode: 'none',
    };
    const refused = await as(t, root).post(servers(), body);
    expect(refused.statusCode).toBe(422);
    expect((refused.json() as ApiErrorBody).error.details).toEqual({ origin: originOf(open.url) });
    await allowMcpOrigins(t, open.url);
    const server = await added(root, body);
    const moved = await as(t, root).patch(`${servers()}/${server.id}`, {
      url: `https://moved-${suffix()}.example.com/mcp`,
    });
    expect(moved.statusCode).toBe(422);
  });
});

describe('every connection reads the list (NF-S4)', () => {
  it('NF-S4: removing an origin stops the next tool call', async () => {
    const fixture = await startMcpHttpServer();
    try {
      await allowMcpOrigins(t, fixture.url);
      const server = await added(root, {
        transport: 'streamable_http',
        name: `rm-${suffix()}`,
        url: fixture.url,
        authMode: 'none',
      });
      const synced = await as(t, root).post(`${servers()}/${server.id}/tools/sync`, {});
      expect(synced.statusCode).toBe(200);
      const echo = (synced.json() as McpToolSyncView).tools.find((tool) => tool.name === 'echo');
      await as(t, root).patch(`/api/workspaces/${alpha.id}/tools/${echo?.id ?? ''}`, {
        enabled: true,
        approvalRequired: false,
      });
      const call = (n: number) => ({
        callId: `call_${n}`,
        name: `${server.name}__echo`,
        arguments: JSON.stringify({ text: 'hi' }),
      });
      const first = await request(member);
      expect(await dispatchToolCall(context(), first, call(1))).toMatchObject({ status: 'ok' });
      const ran = fixture.toolCalls.length;

      const query = `?origin=${encodeURIComponent(originOf(fixture.url))}`;
      expect((await as(t, root).delete(`${ORIGINS}${query}`)).statusCode).toBe(204);
      const second = await request(member);
      const outcome = await dispatchToolCall(context(), second, call(2));
      // Final: the model is told not to try again, and nothing was sent.
      expect(outcome).toMatchObject({ status: 'error', kind: 'terminal' });
      expect(outcome.status === 'error' && outcome.message).toContain('not allowed its server');
      expect(fixture.toolCalls.length).toBe(ran);
      expect(await listToolInvocationsForRequest(t.db, alpha.id, second.requestId)).toMatchObject([
        { status: 'denied', reason: 'origin_not_allowed' },
      ]);
      // The test and a sync say so too.
      const tested = await as(t, root).post(`${servers()}/${server.id}/test`, {});
      expect((tested.json() as McpServerTestView).status).toBe('not_allowed');
      const resync = await as(t, root).post(`${servers()}/${server.id}/tools/sync`, {});
      expect(resync.statusCode).toBe(422);
      const after = (await as(t, root).get(`${servers()}/${server.id}`)).json() as {
        server: McpServerView;
      };
      expect(after.server).toMatchObject({
        lastTestStatus: 'not_allowed',
        lastSync: { error: 'not_allowed' },
      });
    } finally {
      await fixture.close();
    }
  });

  it('NF-S4: a listed name that resolves to a private address is still refused (failure injection)', async () => {
    // Nothing should ever connect here; count anything that tries.
    let connected = 0;
    const trap: Server = createServer((socket) => {
      connected += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', resolve));
    try {
      const port = (trap.address() as AddressInfo).port;
      // A workspace admin's server, public-only, at a name an instance admin listed.
      const publicOrigin = `https://mcp-${suffix()}.example.com`;
      await as(t, root).post(ORIGINS, { origin: publicOrigin });
      const server = await added(wsAdmin, {
        transport: 'streamable_http',
        name: `dns-${suffix()}`,
        url: `${publicOrigin}/mcp`,
        authMode: 'none',
      });
      expect(server.allowPrivate).toBe(false);
      // Its DNS record changes after it was listed: the name now resolves to loopback.
      // `localhost.` is a name, not an address, so it is looked up when connecting.
      const moved = `http://localhost.:${port}`;
      await as(t, root).post(ORIGINS, { origin: moved });
      await t.pool.query('update mcp_servers set url = $1 where id = $2', [
        `${moved}/mcp`,
        server.id,
      ]);
      const tested = await as(t, wsAdmin).post(`${servers()}/${server.id}/test`, {});
      expect((tested.json() as McpServerTestView).status).toBe('unreachable');
      expect(connected).toBe(0);
    } finally {
      await new Promise<void>((resolve) => trap.close(() => resolve()));
    }
  });

  it('NF-S4: an allowlist that cannot be read refuses the connection (failure injection)', async () => {
    await allowMcpOrigins(t, open.url);
    const server = await added(root, {
      transport: 'streamable_http',
      name: `down-${suffix()}`,
      url: open.url,
      authMode: 'none',
    });
    const before = open.authorizations.length;
    await t.pool.query('alter table mcp_allowed_origins rename to mcp_allowed_origins_gone');
    try {
      const tested = await as(t, root).post(`${servers()}/${server.id}/test`, {});
      expect(tested.statusCode).toBe(500);
      expect(open.authorizations.length).toBe(before);
    } finally {
      await t.pool.query('alter table mcp_allowed_origins_gone rename to mcp_allowed_origins');
    }
    const after = await as(t, root).post(`${servers()}/${server.id}/test`, {});
    expect((after.json() as McpServerTestView).status).toBe('ok');
  });
});

describe("the origins an OAuth server's metadata names (NF-S4)", () => {
  let authServer: OAuthFixture;
  let protectedMcp: McpHttpFixture;

  beforeAll(async () => {
    authServer = await startOAuthFixture();
    protectedMcp = await startMcpHttpServer({ oauth: authServer });
    await allowMcpOrigins(t, protectedMcp.url);
  });

  afterAll(async () => {
    await protectedMcp.close();
    await authServer.close();
  });

  const oauthServer = () =>
    added(root, {
      transport: 'streamable_http',
      name: `oauth-${suffix()}`,
      url: protectedMcp.url,
      authMode: 'oauth',
    });

  it('NF-S4: an OAuth server whose authorization server is not listed fails to connect', async () => {
    const server = await oauthServer();
    const refused = await as(t, member).post(`${connections()}/${server.id}`, {});
    expect(refused.statusCode).toBe(422);
    expect((refused.json() as ApiErrorBody).error).toMatchObject({
      code: 'mcp_origin_not_allowed',
      details: { origin: authServer.issuer },
    });
    // Nothing was registered with it.
    expect(authServer.counts.registrations).toBe(0);
  });

  it('NF-S4: a grandfathered OAuth server lists the origins it discovers, once', async () => {
    const server = await oauthServer();
    // As the upgrade that introduced the allowlist marks a server that existed before it.
    await t.pool.query('update mcp_servers set egress_grandfathered = true where id = $1', [
      server.id,
    ]);
    const started = await as(t, member).post(`${connections()}/${server.id}`, {});
    expect(started.statusCode).toBe(200);
    const rows = await t.pool.query<{ source: string }>(
      'select source from mcp_allowed_origins where origin = $1',
      [authServer.issuer],
    );
    expect(rows.rows).toEqual([{ source: 'upgrade' }]);
    const mark = await t.pool.query<{ egress_grandfathered: boolean }>(
      'select egress_grandfathered from mcp_servers where id = $1',
      [server.id],
    );
    expect(mark.rows[0]?.egress_grandfathered).toBe(false);

    // An instance admin removes it: it stays removed.
    const query = `?origin=${encodeURIComponent(authServer.issuer)}`;
    expect((await as(t, root).delete(`${ORIGINS}${query}`)).statusCode).toBe(204);
    expect((await as(t, member).post(`${connections()}/${server.id}`, {})).statusCode).toBe(422);
  });

  it('NF-S4: changing the URL of a grandfathered server ends its grandfathering', async () => {
    const server = await oauthServer();
    await t.pool.query('update mcp_servers set egress_grandfathered = true where id = $1', [
      server.id,
    ]);
    const changed = await as(t, root).patch(`${servers()}/${server.id}`, {
      url: `${protectedMcp.url}?v=2`,
    });
    expect(changed.statusCode).toBe(200);
    const refused = await as(t, member).post(`${connections()}/${server.id}`, {});
    expect(refused.statusCode).toBe(422);
  });
});
