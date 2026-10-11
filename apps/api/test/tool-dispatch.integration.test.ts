import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerView, McpToolSyncView, WorkspaceView } from '@lakka/contracts';
import {
  createLogger,
  dispatchToolCall,
  inProcessExecutor,
  noEvents,
  policySnapshots,
  resolveTools,
  ToolTimeoutError,
} from '@lakka/core';
import type {
  ToolDispatchContext,
  ToolDispatchRequest,
  ToolExecutor,
  ToolSnapshot,
} from '@lakka/core';
import { listToolInvocationsForRequest } from '@lakka/db';
import { startMcpHttpServer } from '../../../test/integration/mcp-http-server.ts';
import type { McpHttpFixture } from '../../../test/integration/mcp-http-server.ts';
import { startOAuthFixture } from '../../../test/integration/oauth-fixture.ts';
import type { OAuthFixture } from '../../../test/integration/oauth-fixture.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The dispatch seam (invariant 7, TL-1 to TL-9, ADR 0070) against real Postgres and fixture MCP
 * servers: the eight checks in order, authorisation as the end user, approval before execution,
 * failures shaped for the model, and an audit row for every call.
 */

const TOKEN = 'shared-token-0123456789';
const CANARY = 'canary-argument-7f3e';

let t: TestApp;
let root: SignedInUser;
let alice: SignedInUser;
let bob: SignedInUser;
let alpha: WorkspaceView;
let open: McpHttpFixture;
let guarded: McpHttpFixture;
let authServer: OAuthFixture;
let protectedMcp: McpHttpFixture;
let openServer: McpServerView;
let sharedServer: McpServerView;
let oauthServer: McpServerView;
const logs: string[] = [];
const { logger } = createLogger({
  level: 'debug',
  service: 'dispatch-test',
  destination: { write: (line: string) => void logs.push(line) },
});

const suffix = () => randomBytes(3).toString('hex');
const base = () => `/api/workspaces/${alpha.id}`;

function context(executor: ToolExecutor = inProcessExecutor): ToolDispatchContext {
  return {
    db: t.db,
    events: noEvents,
    mcpPrivateOrigins: [],
    publicUrl: PUBLIC_URL,
    executor,
    logger,
  };
}

async function addServer(
  url: string,
  authMode: 'none' | 'shared' | 'oauth',
): Promise<McpServerView> {
  const res = await as(t, root).post(`${base()}/mcp-servers`, {
    transport: 'streamable_http',
    name: `srv-${suffix()}`,
    url,
    authMode,
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { server: McpServerView }).server;
}

async function enableAll(server: McpServerView): Promise<void> {
  const res = await as(t, root).post(`${base()}/mcp-servers/${server.id}/tools/sync`, {});
  if (res.statusCode !== 200) throw new Error(res.body);
  for (const tool of (res.json() as McpToolSyncView).tools) {
    if (tool.unusable === null)
      await as(t, root).patch(`${base()}/tools/${tool.id}`, { enabled: true });
  }
}

async function connect(user: SignedInUser, server: McpServerView, name: string): Promise<void> {
  const started = await as(t, user).post(`${base()}/mcp-connections/${server.id}`, {});
  const { authorizationUrl } = started.json() as { authorizationUrl: string };
  const res = await fetch(`${authorizationUrl}&test_user=${name}`, { redirect: 'manual' });
  const back = new URL(res.headers.get('location') ?? '');
  await t.app.inject({
    method: 'GET',
    url: `${back.pathname}${back.search}`,
    headers: { cookie: user.cookie },
  });
}

/** A request as the pipeline will make one: its snapshot, and the tools resolved for its caller. */
async function request(
  user: SignedInUser,
  isApproved: ToolDispatchRequest['isApproved'] = async () => false,
): Promise<ToolDispatchRequest> {
  const policy = await policySnapshots({ db: t.db }).get(alpha.id);
  if (policy === undefined) throw new Error('no policy');
  return {
    requestId: randomUUID(),
    workspaceId: alpha.id,
    principal: user.principal,
    conversationId: null,
    policy,
    offered: await resolveTools(context(), policy, user.principal),
    isApproved,
    signal: new AbortController().signal,
  };
}

let calls = 0;
const call = (name: string, args: unknown) => ({
  callId: `call_${(calls += 1)}`,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

async function audit(req: ToolDispatchRequest) {
  return listToolInvocationsForRequest(t.db, req.workspaceId, req.requestId);
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
    ).json() as {
      workspace: WorkspaceView;
    }
  ).workspace;
  for (const user of [alice, bob]) {
    await as(t, root).put(`${base()}/members/${user.principal.id}`, { role: 'member' });
  }
  openServer = await addServer(open.url, 'none');
  await enableAll(openServer);
  sharedServer = await addServer(guarded.url, 'shared');
  await as(t, root).put(`${base()}/mcp-servers/${sharedServer.id}/credential`, { secret: TOKEN });
  await enableAll(sharedServer);
  oauthServer = await addServer(protectedMcp.url, 'oauth');
  await connect(root, oauthServer, 'root');
  await enableAll(oauthServer);
});

afterAll(async () => {
  await Promise.all([open.close(), guarded.close(), protectedMcp.close()]);
  await authServer.close();
  await t.close();
});

describe('the checks, in order (invariant 7)', () => {
  it('1. existence: a name that is no tool is refused, listing the tools that are', async () => {
    const req = await request(alice);
    const outcome = await dispatchToolCall(context(), req, call('srv-nothing__nope', {}));
    expect(outcome).toMatchObject({ status: 'error', kind: 'fixable' });
    expect(outcome.status === 'error' && outcome.message).toContain(`${openServer.name}__echo`);
    expect(await audit(req)).toMatchObject([
      { status: 'rejected', reason: 'unknown_tool', toolName: 'srv-nothing__nope' },
    ]);
  });

  it('2. allowlist: a workspace tool this caller may not use is refused, and it is final', async () => {
    // Alice has not connected to the OAuth server, so its tools are not hers to use.
    const req = await request(alice);
    const outcome = await dispatchToolCall(context(), req, call(`${oauthServer.name}__whoami`, {}));
    expect(outcome).toMatchObject({ status: 'error', kind: 'terminal' });
    expect((await audit(req))[0]).toMatchObject({ status: 'denied', reason: 'not_allowed' });
  });

  it('3. schema: arguments are checked against the stored schema, and errors name the field', async () => {
    const req = await request(alice);
    const echo = `${openServer.name}__echo`;
    const wrongType = await dispatchToolCall(context(), req, call(echo, { text: 5 }));
    expect(wrongType).toMatchObject({ status: 'error', kind: 'fixable' });
    expect(wrongType.status === 'error' && wrongType.message).toContain("'text'");
    for (const args of ['not json', '[1,2]', { text: 'x'.repeat(17 * 1024) }]) {
      expect(await dispatchToolCall(context(), req, call(echo, args))).toMatchObject({
        status: 'error',
        kind: 'fixable',
      });
    }
    expect(open.toolCalls).not.toContain('echo');
    const rows = await audit(req);
    expect(rows.map((r) => r.reason)).toEqual([
      'invalid_arguments',
      'invalid_arguments',
      'invalid_arguments',
      'arguments_too_large',
    ]);
    // Arguments too big are stored only as their size (ADR 0066 Q3).
    expect(rows[3]?.arguments).toMatchObject({ truncated: true });
    expect(rows[1]?.arguments).toMatchObject({ unparsed: true });
  });

  it('4. semantic: arguments nested absurdly deep never reach a server', async () => {
    const req = await request(alice);
    let deep: unknown = 'x';
    for (let i = 0; i < 30; i += 1) deep = { deeper: deep };
    const outcome = await dispatchToolCall(
      context(),
      req,
      call(`${openServer.name}__echo`, { text: 'a', options: { deep } }),
    );
    // `options` takes any object, so the schema passes and the semantic check refuses it.
    expect(outcome).toMatchObject({ status: 'error', kind: 'fixable' });
    expect((await audit(req))[0]?.reason).toBe('arguments_too_deep');
  });

  it('5. authorisation as the end user: each person calls with their own account, and the audit says whose', async () => {
    await connect(alice, oauthServer, 'alice');
    await connect(bob, oauthServer, 'bob');
    const aliceReq = await request(alice);
    const bobReq = await request(bob);
    const whoami = `${oauthServer.name}__whoami`;
    expect(await dispatchToolCall(context(), aliceReq, call(whoami, {}))).toMatchObject({
      status: 'ok',
      content: 'alice',
    });
    expect(await dispatchToolCall(context(), bobReq, call(whoami, {}))).toMatchObject({
      status: 'ok',
      content: 'bob',
    });
    expect((await audit(aliceReq))[0]).toMatchObject({
      status: 'ok',
      principalId: alice.principal.id,
      credentialPrincipalId: alice.principal.id,
    });

    // A shared credential is recorded as the admin's who set it: the honest answer (TL-6).
    const shared = await request(alice);
    await dispatchToolCall(context(), shared, call(`${sharedServer.name}__echo`, { text: 'hi' }));
    expect((await audit(shared))[0]).toMatchObject({
      status: 'ok',
      credentialPrincipalId: root.principal.id,
    });
  });

  it('6. approval: a tool that asks first does not run without it (AC 18), and runs with it', async () => {
    const del = `${openServer.name}__delete`;
    const before = open.toolCalls.filter((c) => c === 'delete').length;
    const refused = await request(alice);
    const outcome = await dispatchToolCall(context(), refused, call(del, { id: 'r1' }));
    expect(outcome).toMatchObject({ status: 'approval_required', arguments: { id: 'r1' } });
    expect(open.toolCalls.filter((c) => c === 'delete').length).toBe(before);
    expect((await audit(refused))[0]).toMatchObject({ status: 'approval_required' });

    let asked: ToolSnapshot | undefined;
    const approved = await request(alice, async (tool) => {
      asked = tool;
      return true;
    });
    expect(await dispatchToolCall(context(), approved, call(del, { id: 'r1' }))).toMatchObject({
      status: 'ok',
      content: 'deleted',
    });
    expect(asked?.modelName).toBe(del);
    expect(open.toolCalls.filter((c) => c === 'delete').length).toBe(before + 1);
  });

  it('7, 8. execute and shape: a result comes back as text, and the call is audited with its arguments', async () => {
    const req = await request(alice);
    const outcome = await dispatchToolCall(
      context(),
      req,
      call(`${openServer.name}__echo`, { text: CANARY }),
    );
    expect(outcome).toMatchObject({ status: 'ok', content: CANARY });
    const [row] = await audit(req);
    expect(row).toMatchObject({
      status: 'ok',
      arguments: { text: CANARY },
      credentialPrincipalId: null,
    });
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

/** An executor that always fails in one way, counting how often it was asked. */
const failing = (fail: () => never): ToolExecutor & { count: number } => {
  const executor = {
    count: 0,
    async execute() {
      executor.count += 1;
      return fail();
    },
    list: inProcessExecutor.list,
  };
  return executor;
};

/** A connection refused before the call could be sent. */
const unreachable = () => {
  throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
};

describe('failures, shaped for the model', () => {
  it('a timeout is temporary, and the call is not repeated', async () => {
    const executor = failing(() => {
      throw new ToolTimeoutError('slow');
    });
    const req = await request(alice);
    const outcome = await dispatchToolCall(
      context(executor),
      req,
      call(`${openServer.name}__echo`, { text: 'a' }),
    );
    expect(outcome).toMatchObject({ status: 'error', kind: 'retryable' });
    expect(executor.count).toBe(1);
    expect((await audit(req))[0]).toMatchObject({ status: 'timeout' });
  });

  it('an unreachable server is retried once only for a tool that says repeating is harmless', async () => {
    const readOnly = failing(unreachable);
    await dispatchToolCall(
      context(readOnly),
      await request(alice),
      call(`${openServer.name}__echo`, { text: 'a' }),
    );
    expect(readOnly.count).toBe(2);

    const destructive = failing(unreachable);
    const outcome = await dispatchToolCall(
      context(destructive),
      await request(alice, async () => true),
      call(`${openServer.name}__delete`, { id: 'x' }),
    );
    expect(destructive.count).toBe(1);
    expect(outcome).toMatchObject({ status: 'error', kind: 'retryable' });
  });

  it("a tool's own error goes back to the model as something it can act on", async () => {
    const executor: ToolExecutor = {
      execute: async () => ({
        content: [{ type: 'text', text: "Unknown field 'cust_email'." }],
        isError: true,
      }),
      list: inProcessExecutor.list,
    };
    const req = await request(alice);
    const outcome = await dispatchToolCall(
      context(executor),
      req,
      call(`${openServer.name}__echo`, { text: 'a' }),
    );
    expect(outcome).toMatchObject({
      status: 'error',
      kind: 'fixable',
      message: "The tool reported an error: Unknown field 'cust_email'.",
    });
    expect((await audit(req))[0]).toMatchObject({ status: 'failed', reason: 'tool_error' });
  });

  it('NF-S5: arguments are audited, never logged', () => {
    expect(logs.join('\n')).not.toContain(CANARY);
    expect(t.logs.join('\n')).not.toContain(CANARY);
  });
});
