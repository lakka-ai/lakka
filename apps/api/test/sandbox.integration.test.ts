import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  McpServerTestView,
  McpServerView,
  McpToolSyncView,
  WorkspaceView,
} from '@lakka/contracts';
import {
  byTransport,
  createLogger,
  dispatchToolCall,
  inProcessExecutor,
  noEvents,
  policySnapshots,
  resolveTools,
  sandboxExecutor,
  verifyEgressToken,
} from '@lakka/core';
import type { ToolDispatchContext, ToolExecutor } from '@lakka/core';
import { startMcpHttpServer } from '../../../test/integration/mcp-http-server.ts';
import type { McpHttpFixture } from '../../../test/integration/mcp-http-server.ts';
import { allowMcpOrigins, as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * stdio servers in the sandbox (NF-S4, TL-8, ADR 0118), against real Postgres and Valkey: the
 * tool host runs in this process and each runner as a child process, as createTestApp sets up.
 * Every operation on a stdio server, testing, syncing and calling, goes through the tool host,
 * and carries an egress token with the instance's allowlist. The isolation itself, uids, limits
 * and the network, is the stack test's (pnpm test:sandbox).
 */

const STDIO_SERVER = fileURLToPath(
  new URL('../../../test/integration/mcp-plain-stdio.ts', import.meta.url),
);
const LISTED = ['https://tools.example.com', 'http://10.0.0.7:8080'];

const { logger } = createLogger({ level: 'silent', service: 'sandbox-test' });
const suffix = () => randomBytes(3).toString('hex');

let t: TestApp;
let root: SignedInUser;
let alpha: WorkspaceView;
let http: McpHttpFixture;

const ws = (w: WorkspaceView = alpha) => `/api/workspaces/${w.id}`;

async function addStdio(app: TestApp, workspace: WorkspaceView, admin: SignedInUser) {
  const added = await as(app, admin).post(`${ws(workspace)}/mcp-servers`, {
    transport: 'stdio',
    name: `local${suffix()}`,
    command: process.execPath,
    args: [STDIO_SERVER],
    authMode: 'none',
  });
  if (added.statusCode !== 201) throw new Error(added.body);
  return (added.json() as { server: McpServerView }).server;
}

async function addHttp(app: TestApp, workspace: WorkspaceView, admin: SignedInUser) {
  const added = await as(app, admin).post(`${ws(workspace)}/mcp-servers`, {
    transport: 'streamable_http',
    name: `remote${suffix()}`,
    url: http.url,
    authMode: 'none',
  });
  if (added.statusCode !== 201) throw new Error(added.body);
  return (added.json() as { server: McpServerView }).server;
}

const test = async (app: TestApp, admin: SignedInUser, w: WorkspaceView, server: McpServerView) =>
  (
    await as(app, admin).post(`${ws(w)}/mcp-servers/${server.id}/test`, {})
  ).json() as McpServerTestView;

async function setUp(app: TestApp) {
  const admin = await signedInUser(app, 'Root');
  await app.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  const workspace = (
    (
      await as(app, admin).post('/api/workspaces', { name: 'Alpha', slug: `alpha-${suffix()}` })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  return { admin, workspace };
}

beforeAll(async () => {
  http = await startMcpHttpServer();
  t = await createTestApp({ mcpAllowedOrigins: [http.url, ...LISTED] });
  ({ admin: root, workspace: alpha } = await setUp(t));
});

afterAll(async () => {
  await http.close();
  await t.close();
});

describe('stdio servers in the sandbox (NF-S4)', () => {
  it('NF-S4, TL-8: testing, syncing and calling a stdio server all go through the tool host', async () => {
    const server = await addStdio(t, alpha, root);
    const before = t.sandbox.host.operations;

    const tested = await test(t, root, alpha, server);
    expect(tested.status).toBe('ok');
    expect(tested.tools.map((tool) => tool.name)).toContain('environment');
    expect(t.sandbox.host.operations).toBe(before + 1);

    const synced = await as(t, root).post(`${ws()}/mcp-servers/${server.id}/tools/sync`, {});
    expect(synced.statusCode).toBe(200);
    expect(t.sandbox.host.operations).toBe(before + 2);
    for (const tool of (synced.json() as McpToolSyncView).tools) {
      await as(t, root).patch(`${ws()}/tools/${tool.id}`, { enabled: true });
    }

    const context: ToolDispatchContext = {
      db: t.db,
      events: noEvents,
      mcpPrivateOrigins: [],
      publicUrl: PUBLIC_URL,
      executor: t.toolExecutor,
      logger,
    };
    const policy = await policySnapshots({ db: t.db }).get(alpha.id);
    if (policy === undefined) throw new Error('no policy');
    const outcome = await dispatchToolCall(
      context,
      {
        requestId: randomUUID(),
        workspaceId: alpha.id,
        principal: root.principal,
        conversationId: null,
        policy,
        offered: await resolveTools(context, policy, root.principal),
        isApproved: async () => true,
        signal: new AbortController().signal,
      },
      { callId: 'call_1', name: `${server.name}__environment`, arguments: '{}' },
    );
    expect(outcome.status).toBe('ok');
    expect(t.sandbox.host.operations).toBe(before + 3);

    // NF-S4: the call's egress token carries the instance's allowlist, signed with the key.
    const content = outcome.status === 'ok' ? outcome.content : '';
    const token = /http:\/\/t:([A-Za-z0-9._-]+)@127\.0\.0\.1:9/.exec(content)?.[1];
    expect(token).toBeDefined();
    const claims = verifyEgressToken(t.sandbox.egressKey, token ?? '');
    expect(claims?.rule.allowedOrigins.toSorted()).toEqual(
      [new URL(http.url).origin, ...LISTED].toSorted(),
    );
    // Only instance admins add stdio servers, which may reach a listed private address.
    expect(claims?.rule.allowPrivate).toBe(true);
    expect(claims?.exp).toBeLessThanOrEqual(Date.now() + 45_000);
    expect(content).toContain('"nodeUseEnvProxy":"1"');
  });

  it('NF-S4: with the sandbox down, stdio fails closed as unreachable, and HTTP servers still work', async () => {
    const executor: ToolExecutor = byTransport({
      // Nothing listens on port 9.
      stdio: sandboxExecutor({
        toolHost: { kind: 'http', url: 'http://127.0.0.1:9' },
        token: () => 'x'.repeat(43),
        egress: { proxyUrl: 'http://127.0.0.1:9', key: () => 'y'.repeat(43) },
      }),
      http: inProcessExecutor,
    });
    const down = await createTestApp({ toolExecutor: executor, mcpAllowedOrigins: [http.url] });
    try {
      const { admin, workspace } = await setUp(down);
      const stdio = await addStdio(down, workspace, admin);
      expect(await test(down, admin, workspace, stdio)).toEqual({
        status: 'unreachable',
        tools: [],
      });
      const remote = await addHttp(down, workspace, admin);
      expect((await test(down, admin, workspace, remote)).status).toBe('ok');
    } finally {
      await down.close();
    }
  });

  it("NF-S4: without the sandbox's keys, stdio fails closed and nothing runs it elsewhere", async () => {
    const before = t.sandbox.host.operations;
    for (const keys of [
      { token: () => undefined, key: () => t.sandbox.egressKey },
      { token: () => 'x'.repeat(43), key: () => undefined },
    ]) {
      const executor = sandboxExecutor({
        toolHost: { kind: 'http', url: 'http://127.0.0.1:9' },
        token: keys.token,
        egress: { proxyUrl: t.sandbox.egressProxyUrl, key: keys.key },
      });
      const failure = await executor
        .list(
          {
            target: {
              transport: 'stdio',
              url: null,
              command: process.execPath,
              args: [STDIO_SERVER],
              credentialEnv: null,
              allowPrivate: true,
              allowedOrigins: [],
              privateOrigins: [],
            },
            secret: null,
            timeoutMs: 5000,
          },
          new AbortController().signal,
        )
        .catch((e: unknown) => e);
      expect(failure).toMatchObject({ failure: 'unreachable' });
    }
    expect(t.sandbox.host.operations).toBe(before);
  });

  it('NF-S4: an HTTP server is still reached from the api, not the sandbox', async () => {
    await allowMcpOrigins(t, http.url);
    const remote = await addHttp(t, alpha, root);
    const before = t.sandbox.host.operations;
    expect((await test(t, root, alpha, remote)).status).toBe('ok');
    expect(t.sandbox.host.operations).toBe(before);
  });
});
