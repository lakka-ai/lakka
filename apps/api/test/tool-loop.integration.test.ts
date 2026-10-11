import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ConversationSummaryView,
  ConversationView,
  IssuedKey,
  McpServerView,
  McpToolSyncView,
  ModelView,
  ToolGrantView,
  WorkspaceView,
} from '@lakka/contracts';
import { delimitToolResult, TOOL_RESULTS_ARE_DATA } from '@lakka/core';
import { listToolInvocationsForRequest, listUsageForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { startMcpHttpServer } from '../../../test/integration/mcp-http-server.ts';
import type { McpHttpFixture } from '../../../test/integration/mcp-http-server.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The tool loop (TL-4, TL-5, TL-7, TL-9, AC 18, ADR 0071) over /v1/chat/completions, against
 * real Postgres and Valkey, a fixture MCP server and a fake provider that calls tools: rounds,
 * approvals and their continuation, standing approvals, the loop's limits, budgets per round,
 * and tools a client brings.
 */

const DOLLAR = 1_000_000n;

let t: TestApp;
let fake: FakeProvider;
let mcp: McpHttpFixture;
let base: string;
let root: SignedInUser;
let member: SignedInUser;
let colleague: SignedInUser;
let alpha: WorkspaceView;
let server: McpServerView;
let key: IssuedKey;

const suffix = () => randomBytes(3).toString('hex');
const ws = () => `/api/workspaces/${alpha.id}`;

async function customModel(scenario: string, tools = true): Promise<ModelView> {
  const res = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `${scenario}~${suffix()}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
      pdf: false,
      tools,
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
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { model: ModelView }).model;
}

async function conversation(user: SignedInUser = member): Promise<string> {
  const res = await as(t, user).post(`${ws()}/conversations`, {});
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { conversation: ConversationSummaryView }).conversation.id;
}

async function history(id: string, user: SignedInUser = member) {
  const res = await as(t, user).get(`${ws()}/conversations/${id}`);
  return (res.json() as { conversation: ConversationView }).conversation.messages;
}

interface Call {
  body: unknown;
  conversationId?: string;
  user?: SignedInUser;
  bearer?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function post({ body, conversationId, user = member, bearer, headers = {}, signal }: Call) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined
        ? { cookie: user.cookie, origin: PUBLIC_URL }
        : { authorization: `Bearer ${bearer}` }),
      'x-lakka-workspace': alpha.id,
      ...(conversationId === undefined ? {} : { 'x-lakka-conversation': conversationId }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

type Frame = Record<string, unknown> & {
  choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[];
  lakka?: Record<string, unknown>;
  error?: { code?: string };
};

/** A streamed request, read to the end: its frames, its text, and its request id. */
async function stream(call: Call) {
  const res = await post({ ...call, body: { ...(call.body as object), stream: true } });
  const raw = await res.text();
  if (res.status !== 200) return { status: res.status, raw, frames: [], text: '', requestId: '' };
  const frames = raw
    .split('\n\n')
    .map((block) => block.replace(/^data: /, '').trim())
    .filter((data) => data !== '' && data !== '[DONE]')
    .map((data) => JSON.parse(data) as Frame);
  const text = frames
    .flatMap((f) => f.choices ?? [])
    .map((c) => (typeof c.delta?.['content'] === 'string' ? c.delta['content'] : ''))
    .join('');
  return {
    status: res.status,
    raw,
    frames,
    text,
    requestId: res.headers.get('x-lakka-request-id') ?? '',
  };
}

const ask = (model: ModelView, content = 'Do the thing', extra: Record<string, unknown> = {}) => ({
  model: model.id,
  messages: [{ role: 'user', content }],
  max_tokens: 100,
  ...extra,
});

const audited = async (requestId: string) =>
  (await listToolInvocationsForRequest(t.db, alpha.id, requestId)).map((row) => row.status);

function pendingOf(frames: Frame[]) {
  const last = frames.findLast((f) => (f.choices ?? []).some((c) => c.finish_reason != null));
  return last?.lakka?.['pending_approval'] as
    | { id: string; tool: string; arguments: Record<string, unknown> }
    | undefined;
}

const requestsFor = (model: ModelView) => fake.requests.filter((r) => r.model === model.model);

async function liveReservations(): Promise<number> {
  const { rows } = await t.pool.query<{ n: number }>(
    "select count(*)::int as n from reservations where state in ('pending', 'active')",
  );
  return rows[0]?.n ?? 0;
}

/** A member with a cap of their own, so every round holds against it. */
async function budgetedMember(name: string): Promise<SignedInUser> {
  const user = await signedInUser(t, name);
  await as(t, root).put(`${ws()}/members/${user.principal.id}`, { role: 'member' });
  const capped = await as(t, root).put(`${ws()}/budgets/members/${user.principal.id}`, {
    limitMicroUsd: String(DOLLAR),
    period: 'monthly',
  });
  if (capped.statusCode !== 200) throw new Error(capped.body);
  return user;
}

/** How a request's reservations ended, what they charged, and what its attempts cost. */
async function settlement(requestId: string) {
  const { rows } = await t.pool.query<{ state: string; actual: string | null }>(
    `select state, actual_micro_usd::text as actual from reservations
     where request_id = $1 and state <> 'denied' order by created_at`,
    [requestId],
  );
  const used = (await listUsageForRequest(t.db, alpha.id, requestId)).reduce(
    (sum, u) => sum + u.costMicroUsd,
    0n,
  );
  const charged = rows.reduce((sum, r) => sum + BigInt(r.actual ?? '0'), 0n);
  return { states: rows.map((r) => r.state), used, charged };
}

async function grants(user: SignedInUser): Promise<ToolGrantView[]> {
  return ((await as(t, user).get(`${ws()}/tool-grants`)).json() as { grants: ToolGrantView[] })
    .grants;
}

beforeAll(async () => {
  mcp = await startMcpHttpServer();
  t = await createTestApp({ mcpAllowedOrigins: [mcp.url] });
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  [root, member, colleague] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Member'),
    signedInUser(t, 'Colleague'),
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
  for (const user of [member, colleague]) {
    await as(t, root).put(`${ws()}/members/${user.principal.id}`, { role: 'member' });
  }
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  const fallback = await customModel('ok');
  await as(t, root).put(`${ws()}/routing/settings`, {
    routingEnabled: false,
    defaultModel: fallback.id,
    pinnedModel: null,
  });
  const added = await as(t, root).post(`${ws()}/mcp-servers`, {
    transport: 'streamable_http',
    name: `files${suffix()}`,
    url: mcp.url,
    authMode: 'none',
  });
  server = (added.json() as { server: McpServerView }).server;
  const synced = await as(t, root).post(`${ws()}/mcp-servers/${server.id}/tools/sync`, {});
  for (const tool of (synced.json() as McpToolSyncView).tools) {
    await as(t, root).patch(`${ws()}/tools/${tool.id}`, { enabled: true });
  }
  key = (await as(t, member).post(`${ws()}/keys`, { name: 'Script' })).json() as IssuedKey;
});

afterAll(async () => {
  await Promise.all([fake.close(), mcp.close()]);
  await t.close();
});

describe('rounds (TL-7, H7, H8, H9)', () => {
  it('TL-7: a tool the model calls runs, and its result goes back delimited, as data', async () => {
    const model = await customModel('tool-echo');
    const id = await conversation();
    const ran = mcp.toolCalls.length;
    const res = await stream({ body: ask(model), conversationId: id });
    expect(res.status).toBe(200);
    // Only the model's text reaches the client. The one extension says a call happened, for chat
    // to show (TL-6), with the tool's name and outcome: never its arguments or its result.
    const extensions = res.frames.flatMap((f) => (f.lakka === undefined ? [] : [f.lakka]));
    expect(extensions).toEqual([
      {
        tool_activity: {
          call_id: expect.stringMatching(/^call_/),
          name: `${server.name}__echo`,
          status: 'ok',
        },
      },
    ]);
    expect(JSON.stringify(extensions)).not.toContain('hi');
    expect(res.text).toBe(`Tool said: ${delimitToolResult(`${server.name}__echo`, 'hi')}`);
    expect(mcp.toolCalls.slice(ran)).toEqual(['echo']);

    // The model was told results are data, offered the stored definitions, and given the result
    // as a tool message in its own frame.
    const [first, second] = requestsFor(model);
    if (first === undefined) throw new Error('the provider was not called');
    const firstMessages = first.body['messages'] as { role: string; content: unknown }[];
    expect(firstMessages[0]).toMatchObject({ role: 'system' });
    expect(JSON.stringify(firstMessages[0]?.content)).toContain(TOOL_RESULTS_ARE_DATA.slice(0, 40));
    expect(
      (first.body['tools'] as { function: { name: string } }[]).map((tool) => tool.function.name),
    ).toContain(`${server.name}__delete`);
    expect(second?.body['messages']).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        content: delimitToolResult(`${server.name}__echo`, 'hi'),
      }),
    );

    // The audit, the history and the budget: one row per round, all settled.
    expect(await listToolInvocationsForRequest(t.db, alpha.id, res.requestId)).toMatchObject([
      { status: 'ok', toolName: `${server.name}__echo`, conversationId: id },
    ]);
    const usage = await listUsageForRequest(t.db, alpha.id, res.requestId);
    expect(usage.map((u) => u.attempt).toSorted()).toEqual([1, 2]);
    expect(await liveReservations()).toBe(0);
    const messages = await history(id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1]?.toolCalls).toEqual([
      { callId: expect.any(String), name: `${server.name}__echo` },
    ]);
    expect(messages[2]).toMatchObject({ toolName: `${server.name}__echo`, content: 'hi' });
    expect(messages[3]?.content).toBe(res.text);
    // TL-6, CH-1: chat shows each call from the audit, and the request's cost once, at its end.
    expect(messages[1]?.tools).toEqual([
      {
        callId: messages[1]?.toolCalls?.[0]?.callId,
        name: `${server.name}__echo`,
        arguments: expect.anything(),
        status: 'ok',
        durationMs: expect.any(Number),
        asked: false,
      },
    ]);
    expect(messages[2]?.toolCallId).toBe(messages[1]?.toolCalls?.[0]?.callId);
    expect(messages[1]?.costMicroUsd).toBeNull();
    expect(messages[3]?.costMicroUsd).toMatch(/^\d+$/);
  });

  it('H3: without a conversation, or with a model that cannot call tools, no tools are offered', async () => {
    const model = await customModel('tool-echo');
    const plain = await customModel('tool-echo', false);
    expect((await stream({ body: ask(model) })).text).toBe('Tool said: ');
    expect((await stream({ body: ask(plain), conversationId: await conversation() })).text).toBe(
      'Tool said: ',
    );
    for (const request of [...requestsFor(model), ...requestsFor(plain)]) {
      expect(request.body['tools']).toBeUndefined();
    }
  });

  it('a non-streamed request answers with the final text, and no tool calls for the client', async () => {
    const model = await customModel('tool-echo');
    const res = await post({ body: ask(model), conversationId: await conversation() });
    const body = (await res.json()) as {
      choices: { message: { content: string; tool_calls?: unknown }; finish_reason: string }[];
      lakka?: unknown;
    };
    expect(body.choices[0]?.message.content).toContain('hi');
    expect(body.choices[0]?.message.tool_calls).toBeUndefined();
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.lakka).toBeUndefined();
  });

  it('H5: a non-streamed request that stops for approval says so beside the reply', async () => {
    const model = await customModel('tool-delete');
    const res = await post({ body: ask(model), conversationId: await conversation() });
    const body = (await res.json()) as { lakka: { pending_approval: { tool: string } } };
    expect(body.lakka.pending_approval).toMatchObject({ tool: `${server.name}__delete` });
  });
});

describe('approvals (TL-4, AC 18, H5)', () => {
  it('AC 18: a tool that asks first does not run until the principal who called it approves', async () => {
    const model = await customModel('tool-delete');
    const id = await conversation();
    const ran = mcp.toolCalls.length;
    const res = await stream({ body: ask(model), conversationId: id });
    expect(res.status).toBe(200);
    const pending = pendingOf(res.frames);
    expect(pending).toEqual({
      id: expect.any(String),
      tool: `${server.name}__delete`,
      arguments: { id: '42' },
    });
    expect(mcp.toolCalls.slice(ran)).toEqual([]);
    expect(await listToolInvocationsForRequest(t.db, alpha.id, res.requestId)).toMatchObject([
      { status: 'approval_required' },
    ]);
    const approvalId = pending?.id ?? '';

    // Nobody else can answer it: not a colleague, and not the member's own key either.
    const other = await post({
      body: ask(model),
      conversationId: id,
      user: colleague,
      headers: { 'x-lakka-approve': approvalId },
    });
    expect(other.status).toBe(404);
    const byKey = await post({
      body: ask(model),
      conversationId: id,
      bearer: key.secret,
      headers: { 'x-lakka-approve': approvalId },
    });
    expect(byKey.status).toBe(404);
    expect(mcp.toolCalls.slice(ran)).toEqual([]);

    const approved = await stream({
      body: ask(model),
      conversationId: id,
      headers: { 'x-lakka-approve': approvalId },
    });
    expect(approved.status).toBe(200);
    expect(mcp.toolCalls.slice(ran)).toEqual(['delete']);
    expect(approved.text).toBe(
      `Tool said: ${delimitToolResult(`${server.name}__delete`, 'deleted')}`,
    );
    expect(await listToolInvocationsForRequest(t.db, alpha.id, approved.requestId)).toMatchObject([
      { status: 'ok', toolName: `${server.name}__delete` },
    ]);
    // One approval, one run.
    const again = await post({
      body: ask(model),
      conversationId: id,
      headers: { 'x-lakka-approve': approvalId },
    });
    expect(again.status).toBe(404);
    expect((await history(id)).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('TL-4: the conversation shows the call it waits on, to its owner, until it is answered', async () => {
    const model = await customModel('tool-delete');
    const id = await conversation();
    const pending = pendingOf((await stream({ body: ask(model), conversationId: id })).frames);
    const view = async () => {
      const res = await as(t, member).get(`${ws()}/conversations/${id}`);
      return (res.json() as { conversation: ConversationView }).conversation.pendingApproval;
    };
    expect(await view()).toEqual({
      id: pending?.id,
      tool: `${server.name}__delete`,
      title: null,
      arguments: { id: '42' },
      yours: true,
      keyName: null,
      createdAt: expect.any(String),
    });
    expect((await as(t, colleague).get(`${ws()}/conversations/${id}`)).statusCode).toBe(404);
    await stream({
      body: ask(model),
      conversationId: id,
      headers: { 'x-lakka-approve': pending?.id ?? '' },
    });
    expect(await view()).toBeNull();
    // TL-4: once answered, the call shows that it asked first, and that it ran.
    const round = (await history(id)).find((m) => (m.tools?.length ?? 0) > 0);
    expect(round?.tools?.[0]).toMatchObject({ status: 'ok', asked: true });
  });

  it("TL-4: a call made by the owner's key is shown to the owner as not theirs, naming the key", async () => {
    const model = await customModel('tool-delete');
    const id = await conversation();
    await post({ body: ask(model), conversationId: id, bearer: key.secret });
    const res = await as(t, member).get(`${ws()}/conversations/${id}`);
    expect(
      (res.json() as { conversation: ConversationView }).conversation.pendingApproval,
    ).toMatchObject({ yours: false, keyName: 'Script' });
  });

  it('AC 18: a denied call never runs, and the model is told so', async () => {
    const model = await customModel('tool-delete');
    const id = await conversation();
    const ran = mcp.toolCalls.length;
    const pending = pendingOf((await stream({ body: ask(model), conversationId: id })).frames);
    const denied = await stream({
      body: ask(model),
      conversationId: id,
      headers: { 'x-lakka-deny': pending?.id ?? '' },
    });
    expect(denied.status).toBe(200);
    expect(denied.text).toMatch(/declined/i);
    expect(mcp.toolCalls.slice(ran)).toEqual([]);
    expect(await listToolInvocationsForRequest(t.db, alpha.id, denied.requestId)).toMatchObject([
      { status: 'denied' },
    ]);
  });

  it('a new message moves on: the call it was waiting on can no longer be approved', async () => {
    const model = await customModel('tool-delete');
    const id = await conversation();
    const pending = pendingOf((await stream({ body: ask(model), conversationId: id })).frames);
    await stream({ body: ask(await customModel('ok'), 'Never mind'), conversationId: id });
    const late = await post({
      body: ask(model),
      conversationId: id,
      headers: { 'x-lakka-approve': pending?.id ?? '' },
    });
    expect(late.status).toBe(404);
  });

  it('with two calls in a round, the one that asks stops the run, and the other still runs', async () => {
    const model = await customModel('tool-echo.delete');
    const id = await conversation();
    const ran = mcp.toolCalls.length;
    const res = await stream({ body: ask(model), conversationId: id });
    expect(await audited(res.requestId)).toEqual(['ok', 'approval_required']);
    expect(mcp.toolCalls.slice(ran)).toEqual(['echo']);
    const approved = await stream({
      body: ask(model),
      conversationId: id,
      headers: { 'x-lakka-approve': pendingOf(res.frames)?.id ?? '' },
    });
    expect(mcp.toolCalls.slice(ran)).toEqual(['echo', 'delete']);
    expect(approved.text).toContain('hi');
    expect(approved.text).toContain('deleted');
  });

  it('refuses approval headers that do not make sense', async () => {
    const model = await customModel('tool-delete');
    const id = await conversation();
    const uuid = '00000000-0000-4000-8000-000000000000';
    for (const headers of [
      { 'x-lakka-approve': uuid, 'x-lakka-deny': uuid },
      { 'x-lakka-approve-scope': 'always' },
      { 'x-lakka-approve': uuid, 'x-lakka-approve-scope': 'forever' },
      { 'x-lakka-approve': 'not-a-uuid' },
    ]) {
      expect((await post({ body: ask(model), conversationId: id, headers })).status).toBe(400);
    }
    // Outside a conversation there is nothing to approve.
    expect((await post({ body: ask(model), headers: { 'x-lakka-approve': uuid } })).status).toBe(
      400,
    );
  });
});

describe('standing approvals (TL-5)', () => {
  it('TL-5: approving "always" lets the tool run for that person without asking, until revoked', async () => {
    const model = await customModel('tool-delete');
    const first = await conversation(colleague);
    const pending = pendingOf(
      (await stream({ body: ask(model), conversationId: first, user: colleague })).frames,
    );
    await stream({
      body: ask(model),
      conversationId: first,
      user: colleague,
      headers: { 'x-lakka-approve': pending?.id ?? '', 'x-lakka-approve-scope': 'always' },
    });
    const [grant] = await grants(colleague);
    expect(grant).toMatchObject({
      principalId: colleague.principal.id,
      principalName: 'Colleague',
      modelName: `${server.name}__delete`,
    });
    // Theirs only: the member is still asked.
    expect(await grants(member)).toEqual([]);

    const ran = mcp.toolCalls.length;
    const next = await stream({
      body: ask(model),
      conversationId: await conversation(colleague),
      user: colleague,
    });
    expect(pendingOf(next.frames)).toBeUndefined();
    expect(mcp.toolCalls.slice(ran)).toEqual(['delete']);
    const theirs = await stream({ body: ask(model), conversationId: await conversation() });
    expect(pendingOf(theirs.frames)).toBeDefined();

    // Someone else cannot revoke it through their own list; its holder can.
    expect((await as(t, member).delete(`${ws()}/tool-grants/${grant?.id}`)).statusCode).toBe(404);
    expect((await as(t, colleague).delete(`${ws()}/tool-grants/${grant?.id}`)).statusCode).toBe(
      204,
    );
    const after = await stream({
      body: ask(model),
      conversationId: await conversation(colleague),
      user: colleague,
    });
    expect(pendingOf(after.frames)).toBeDefined();
  });

  it("TL-5: a workspace admin sees and revokes everyone's standing approvals; a member cannot", async () => {
    const model = await customModel('tool-delete');
    const id = await conversation();
    const pending = pendingOf((await stream({ body: ask(model), conversationId: id })).frames);
    // The member's own key may approve the call, but not for good.
    expect(
      (
        await post({
          body: ask(model),
          conversationId: id,
          bearer: key.secret,
          headers: {
            'x-lakka-approve': pending?.id ?? '',
            'x-lakka-approve-scope': 'always',
          },
        })
      ).status,
    ).toBe(400);
    await stream({
      body: ask(model),
      conversationId: id,
      headers: { 'x-lakka-approve': pending?.id ?? '', 'x-lakka-approve-scope': 'always' },
    });
    expect((await as(t, member).get(`${ws()}/tools/grants`)).statusCode).toBe(403);
    const all = (
      (await as(t, root).get(`${ws()}/tools/grants`)).json() as { grants: ToolGrantView[] }
    ).grants;
    const grant = all.find((g) => g.principalId === member.principal.id);
    expect(grant).toBeDefined();
    expect((await as(t, member).delete(`${ws()}/tools/grants/${grant?.id}`)).statusCode).toBe(403);
    expect((await as(t, root).delete(`${ws()}/tools/grants/${grant?.id}`)).statusCode).toBe(204);
    expect(await grants(member)).toEqual([]);
  });
});

describe('limits (TL-9, H6)', () => {
  it('TL-9: a loop stops after 8 rounds of tool calls, and the model answers without tools', async () => {
    const model = await customModel('tool-forever');
    const ran = mcp.toolCalls.length;
    const res = await stream({ body: ask(model), conversationId: await conversation() });
    expect(res.status).toBe(200);
    expect(mcp.toolCalls.length - ran).toBe(8);
    const requests = requestsFor(model);
    expect(requests).toHaveLength(10);
    expect(requests.at(-1)?.body['tools']).toBeUndefined();
    expect(await liveReservations()).toBe(0);
    const usage = await listUsageForRequest(t.db, alpha.id, res.requestId);
    expect(usage.map((u) => u.attempt).toSorted((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('H6: the same call made twice is refused, and ends the loop', async () => {
    const model = await customModel('tool-repeat');
    const ran = mcp.toolCalls.length;
    const res = await stream({ body: ask(model), conversationId: await conversation() });
    expect(res.status).toBe(200);
    expect(mcp.toolCalls.length - ran).toBe(1);
    expect(requestsFor(model)).toHaveLength(3);
    expect(requestsFor(model).at(-1)?.body['tools']).toBeUndefined();
    expect(
      (await listToolInvocationsForRequest(t.db, alpha.id, res.requestId)).map((r) => r.status),
    ).toEqual(['ok', 'rejected']);
  });
});

describe('budgets per round (H8, invariant 4)', () => {
  it('H8: a round that does not fit under the cap ends the run with the refusal, keeping what was done', async () => {
    const budgeted = await signedInUser(t, 'Budgeted');
    await as(t, root).put(`${ws()}/members/${budgeted.principal.id}`, { role: 'member' });
    const model = await customModel('tool-echo');
    // A first run, under a generous cap, to learn what its first round holds.
    const capAt = async (limit: bigint) =>
      (
        await as(t, root).put(`${ws()}/budgets/members/${budgeted.principal.id}`, {
          limitMicroUsd: String(limit),
          period: 'monthly',
        })
      ).statusCode;
    expect(await capAt(DOLLAR)).toBe(200);
    const probe = await stream({
      body: ask(model),
      conversationId: await conversation(budgeted),
      user: budgeted,
    });
    const { rows } = await t.pool.query<{ amount: string }>(
      'select amount_micro_usd::text as amount from reservations where request_id = $1 order by created_at limit 1',
      [probe.requestId],
    );
    const held = BigInt(rows[0]?.amount ?? '0');
    const spent = (await listUsageForRequest(t.db, alpha.id, probe.requestId)).reduce(
      (sum, u) => sum + u.costMicroUsd,
      0n,
    );
    // Room for the first round and no more: the second round holds more, since its prompt grew.
    expect(held).toBeGreaterThan(0n);
    expect(await capAt(spent + held + 20n)).toBe(200);

    const id = await conversation(budgeted);
    const ran = mcp.toolCalls.length;
    const res = await stream({ body: ask(model), conversationId: id, user: budgeted });
    expect(res.status).toBe(200);
    expect(mcp.toolCalls.slice(ran)).toEqual(['echo']);
    expect(res.frames.at(-1)?.error?.code).toBe('budget_exceeded');
    expect(await liveReservations()).toBe(0);
    expect((await history(id, budgeted)).map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('BG-5: a later round that breaks mid-stream is settled at once, charging what it used', async () => {
    const user = await budgetedMember('Broken');
    const model = await customModel('toolthen-echo-drop-after-2');
    const res = await stream({ body: ask(model), conversationId: await conversation(user), user });
    expect(res.status).toBe(200);
    expect(res.frames.at(-1)?.error?.code).toBe('stream_interrupted');
    // The reply has ended, so both rounds are settled now, not left to the sweep.
    const after = await settlement(res.requestId);
    expect(after.states).toEqual(['settled', 'settled']);
    expect(after.used).toBeGreaterThan(0n);
    expect(after.charged).toBe(after.used);
  });

  it('BG-5: a client that goes away during a later round leaves it settled, not held', async () => {
    const user = await budgetedMember('Leaver');
    const model = await customModel('toolthen-echo-slow');
    const controller = new AbortController();
    const res = await post({
      body: { ...ask(model), stream: true },
      conversationId: await conversation(user),
      user,
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-lakka-request-id') ?? '';
    if (res.body === null) throw new Error('no body');
    // Read until the second round is streaming, then leave.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('w0 ')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the reply ended before the second round streamed');
      seen += decoder.decode(value, { stream: true });
    }
    controller.abort();
    await reader.read().catch(() => undefined);

    const deadline = Date.now() + 5000;
    let after = await settlement(requestId);
    while (after.states.some((s) => s === 'pending' || s === 'active') && Date.now() < deadline) {
      await sleep(50);
      after = await settlement(requestId);
    }
    expect(after.states).toEqual(['settled', 'settled']);
    expect(after.charged).toBe(after.used);
    const outcomes = (await listUsageForRequest(t.db, alpha.id, requestId)).map((u) => u.outcome);
    expect(outcomes).toEqual(['completed', 'aborted']);
  });
});

describe("a client's own tools (H4)", () => {
  const clientTools = [
    {
      type: 'function',
      function: {
        name: 'echo',
        description: 'Echoes',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      },
    },
  ];

  it('H4: calls to tools the client brought come back to the client to run', async () => {
    const model = await customModel('tool-echo');
    const streamed = await stream({ body: ask(model, 'x', { tools: clientTools }) });
    expect(streamed.status).toBe(200);
    const deltas = streamed.frames.flatMap((f) => f.choices ?? []);
    expect(deltas.flatMap((c) => (c.delta?.['tool_calls'] as unknown[] | undefined) ?? [])).toEqual(
      [
        {
          index: 0,
          id: expect.any(String),
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hi"}' },
        },
      ],
    );
    expect(deltas.at(-1)?.finish_reason).toBe('tool_calls');

    const res = await post({ body: ask(model, 'x', { tools: clientTools }) });
    const body = (await res.json()) as {
      choices: {
        message: { content: string | null; tool_calls: { id: string }[] };
        finish_reason: string;
      }[];
    };
    const choice = body.choices[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message.content).toBeNull();
    const callId = choice?.message.tool_calls[0]?.id ?? '';

    // The client runs it and sends the result back.
    const answered = await stream({
      body: {
        model: model.id,
        max_tokens: 100,
        tools: clientTools,
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: null, tool_calls: choice?.message.tool_calls },
          { role: 'tool', tool_call_id: callId, content: 'client result' },
        ],
      },
    });
    expect(answered.text).toBe('Tool said: client result');
    expect(requestsFor(model).at(-1)?.body['messages']).toContainEqual(
      expect.objectContaining({ role: 'tool', tool_call_id: callId, content: 'client result' }),
    );
  });

  it("H4: in a conversation with the workspace's tools, a client cannot bring its own", async () => {
    const model = await customModel('tool-echo');
    const res = await post({
      body: ask(model, 'x', { tools: clientTools }),
      conversationId: await conversation(),
    });
    expect(res.status).toBe(400);
  });
});
