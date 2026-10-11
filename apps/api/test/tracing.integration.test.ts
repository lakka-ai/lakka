import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerView, McpToolSyncView, ModelView, WorkspaceView } from '@lakka/contracts';
import { listSpansForRequest } from '@lakka/db';
import type { SpanRow } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { startPlainMcpServer } from '../../../test/integration/mcp-plain-server.ts';
import type { PlainMcpServer } from '../../../test/integration/mcp-plain-server.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The local trace store (OB-1 to OB-3, AC 19, ADR 0076), against real Postgres: every request
 * leaves one trace, with the policy spans, a span for every model call and tool call, and the
 * budget settled at the end; nothing of what was said is in it, and a trace is read within its
 * workspace only.
 */

let t: TestApp;
let fake: FakeProvider;
let mcp: PlainMcpServer;
let base: string;
let root: SignedInUser;
let member: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let ok: ModelView;
let toolModel: ModelView;

const suffix = () => randomBytes(3).toString('hex');

async function customModel(scenario: string, tools = false): Promise<ModelView> {
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

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', { name, slug: `${name}-${suffix()}` });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function chat(body: object, conversationId?: string) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: member.cookie,
      origin: PUBLIC_URL,
      'x-lakka-workspace': alpha.id,
      ...(conversationId === undefined ? {} : { 'x-lakka-conversation': conversationId }),
    },
    body: JSON.stringify({ max_tokens: 100, ...body }),
  });
  await res.text();
  return { status: res.status, requestId: res.headers.get('x-lakka-request-id') ?? '' };
}

/** The request's spans, once its root has been written: it ends after the reply is settled. */
async function traceOf(requestId: string): Promise<SpanRow[]> {
  for (let i = 0; i < 40; i += 1) {
    await t.tracing.forceFlush();
    const rows = await listSpansForRequest(t.db, alpha.id, requestId);
    if (rows.some((r) => r.name === 'request')) return rows;
    await sleep(50);
  }
  throw new Error('the request span was never written');
}

const named = (rows: SpanRow[], name: string) => rows.filter((r) => r.name === name);

beforeAll(async () => {
  fake = await startFakeProvider();
  mcp = await startPlainMcpServer();
  t = await createTestApp({ mcpAllowedOrigins: [mcp.url] });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  [root, member] = await Promise.all([signedInUser(t, 'Root'), signedInUser(t, 'Member')]);
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = await workspace('alpha');
  bravo = await workspace('bravo');
  await as(t, root).put(`/api/workspaces/${alpha.id}/members/${member.principal.id}`, {
    role: 'member',
  });
  await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  ok = await customModel('ok');
  toolModel = await customModel('tool-echo', true);
  await as(t, root).put(`/api/workspaces/${alpha.id}/routing/settings`, {
    routingEnabled: false,
    defaultModel: ok.id,
    pinnedModel: null,
  });
  // A cap, so the budget is held and settled, and both are traced.
  await as(t, root).put(`/api/workspaces/${alpha.id}/budgets/members/${member.principal.id}`, {
    limitMicroUsd: '10000000',
    period: 'monthly',
  });
  const added = await as(t, root).post(`/api/workspaces/${alpha.id}/mcp-servers`, {
    transport: 'streamable_http',
    name: `files${suffix()}`,
    url: mcp.url,
    authMode: 'none',
  });
  const server = (added.json() as { server: McpServerView }).server;
  const synced = await as(t, root).post(
    `/api/workspaces/${alpha.id}/mcp-servers/${server.id}/tools/sync`,
    {},
  );
  for (const tool of (synced.json() as McpToolSyncView).tools) {
    await as(t, root).patch(`/api/workspaces/${alpha.id}/tools/${tool.id}`, { enabled: true });
  }
});

afterAll(async () => {
  await Promise.all([fake?.close(), mcp?.close()]);
  await t?.close();
});

describe('traces (OB-1, OB-3)', () => {
  it('AC 19: every model call is a span with model, tokens, cost, latency and routing decision', async () => {
    const { status, requestId } = await chat({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(status).toBe(200);
    const rows = await traceOf(requestId);

    // One trace, rooted at the request.
    const [request] = named(rows, 'request');
    expect(request).toMatchObject({
      kind: 'server',
      parentSpanId: null,
      workspaceId: alpha.id,
      attributes: {
        'lakka.surface': 'chat',
        'lakka.principal_id': member.principal.id,
        'lakka.outcome': 'completed',
        'lakka.model': ok.id,
      },
    });
    expect(new Set(rows.map((r) => r.traceId))).toEqual(new Set([request?.traceId]));
    for (const name of [
      'policy.resolve_model',
      'policy.reserve_budget',
      'gateway.dispatch',
      'policy.reconcile',
    ]) {
      expect(named(rows, name).map((r) => r.name)).toEqual([name]);
    }

    const [call] = rows.filter((r) => r.name.startsWith('chat '));
    expect(call).toMatchObject({
      kind: 'client',
      status: 'ok',
      attributes: {
        'gen_ai.request.model': ok.model,
        'gen_ai.usage.input_tokens': 50,
        'gen_ai.usage.output_tokens': 8,
        'lakka.model': ok.id,
        'lakka.routing.rule': 'default',
      },
    });
    expect(call?.attributes['lakka.cost_micro_usd']).toBeGreaterThan(0);
    expect(call?.durationMs).toBeGreaterThan(0);

    const [reconcile] = named(rows, 'policy.reconcile');
    expect(reconcile?.attributes).toMatchObject({
      'lakka.budget.reserved_micro_usd': expect.any(Number),
      'lakka.budget.actual_micro_usd': call?.attributes['lakka.cost_micro_usd'],
    });
  });

  it('OB-1: tool calls are spans in their request trace, with each round of the loop', async () => {
    const conversation = await as(t, member).post(`/api/workspaces/${alpha.id}/conversations`, {});
    const id = (conversation.json() as { conversation: { id: string } }).conversation.id;
    const { status, requestId } = await chat(
      { model: toolModel.id, messages: [{ role: 'user', content: 'Echo something' }] },
      id,
    );
    expect(status).toBe(200);
    const rows = await traceOf(requestId);
    const [request] = named(rows, 'request');
    const [tool] = named(rows, 'execute_tool');
    expect(tool).toMatchObject({
      traceId: request?.traceId,
      parentSpanId: request?.spanId,
      attributes: { 'lakka.tool.status': 'ok' },
    });
    expect(String(tool?.attributes['lakka.tool.name'])).toMatch(/__echo$/);
    // Two rounds, each a model call, each settled on its own (ADR 0071).
    expect(rows.filter((r) => r.name.startsWith('chat '))).toHaveLength(2);
    expect(named(rows, 'policy.reconcile')).toHaveLength(2);
  });

  it('OB-4: what was said is not in the trace store', async () => {
    const canary = `canary-${randomBytes(6).toString('hex')}`;
    const { requestId } = await chat({
      model: ok.id,
      messages: [
        { role: 'system', content: `system ${canary}` },
        { role: 'user', content: `user ${canary}` },
      ],
    });
    await traceOf(requestId);
    const { rows } = await t.pool.query<{ n: number }>(
      'select count(*)::int as n from spans where attributes::text like $1 or events::text like $1 or name like $1',
      [`%${canary}%`],
    );
    expect(rows[0]?.n).toBe(0);
    // Nor the reply.
    const reply = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from spans where attributes::text like '%Hello there%'",
    );
    expect(reply.rows[0]?.n).toBe(0);
  });

  it('a refused request is traced, with why', async () => {
    await as(t, root).put(`/api/workspaces/${alpha.id}/budgets/members/${member.principal.id}`, {
      limitMicroUsd: '1',
      period: 'monthly',
    });
    try {
      const { status, requestId } = await chat({
        model: ok.id,
        messages: [{ role: 'user', content: 'Too dear' }],
      });
      expect(status).toBe(402);
      const rows = await traceOf(requestId);
      expect(named(rows, 'request')[0]).toMatchObject({
        status: 'error',
        errorType: 'budget_exceeded',
      });
      expect(named(rows, 'policy.reserve_budget')[0]).toMatchObject({ status: 'error' });
      expect(rows.some((r) => r.name.startsWith('chat '))).toBe(false);
    } finally {
      await as(t, root).put(`/api/workspaces/${alpha.id}/budgets/members/${member.principal.id}`, {
        limitMicroUsd: '10000000',
        period: 'monthly',
      });
    }
  });

  it('AC 16: a trace is read within its workspace only', async () => {
    const { requestId } = await chat({ model: ok.id, messages: [{ role: 'user', content: 'Hi' }] });
    const rows = await traceOf(requestId);
    expect(rows.every((r) => r.workspaceId === alpha.id)).toBe(true);
    expect(await listSpansForRequest(t.db, bravo.id, requestId)).toEqual([]);
  });

  it('OB-6: spans are partitioned by month, and this month and the next two exist', async () => {
    const now = new Date();
    const names = [0, 1, 2].map((ahead) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
      return `spans_y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    const { rows } = await t.pool.query<{ name: string }>(
      "select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent where p.relname = 'spans'",
    );
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(names));
  });
});
