import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetUnavailableError } from '@lakka/contracts';
import type {
  ConversationSummaryView,
  IssuedKey,
  McpServerView,
  McpToolSyncView,
  ModelView,
  WorkspaceView,
} from '@lakka/contracts';
import {
  cacheScript,
  createCacheClient,
  createLogger,
  handleModelRequest,
  fixedCatalogue,
  loadCatalogue,
  noClassifier,
  policySnapshots,
  valkeyEvents,
} from '@lakka/core';
import type { ModelRateLimit, ModelRequest, PipelineContext } from '@lakka/core';
import { listSpansForRequest, listUsageForRequest } from '@lakka/db';
import type { SpanRow } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { startMcpHttpServer } from '../../../test/integration/mcp-http-server.ts';
import type { McpHttpFixture } from '../../../test/integration/mcp-http-server.ts';
import { as, createTestApp, PUBLIC_URL, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The per-person rate limit on model requests (BG-12, ADR 0113) over /v1/chat/completions,
 * against real Postgres and Valkey, a fake provider and a fixture MCP server: refusals before
 * anything is held or sent, concurrency, keys drawing on their owner's bucket, refill, tool
 * loops and approvals, access checked first, a flushed bucket, and Valkey unreachable.
 */

const DOLLAR = 1_000_000n;

// The app reads the limit on every request, so each test sets its own. The bucket is per
// person, so each test uses people of its own.
const limit: ModelRateLimit = {
  perMinute: 60,
  burst: 10,
  keyPrefix: `model-rate-test-${randomBytes(4).toString('hex')}:`,
};

let t: TestApp;
let fake: FakeProvider;
let mcp: McpHttpFixture;
let base: string;
let root: SignedInUser;
let alpha: WorkspaceView;
let ok: ModelView;
let server: McpServerView;

const suffix = () => randomBytes(3).toString('hex');
const ws = () => `/api/workspaces/${alpha.id}`;

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

/** A new member of the workspace, with a bucket of their own. */
async function person(name: string): Promise<SignedInUser> {
  const user = await signedInUser(t, name);
  const added = await as(t, root).put(`${ws()}/members/${user.principal.id}`, { role: 'member' });
  if (added.statusCode !== 200) throw new Error(added.body);
  return user;
}

type Caller = { user: SignedInUser } | { key: IssuedKey };

interface Call {
  model?: ModelView;
  conversationId?: string;
  headers?: Record<string, string>;
  workspaceId?: string;
}

/** One chat completion, read to the end. */
async function complete(caller: Caller, call: Call = {}) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...('key' in caller
        ? { authorization: `Bearer ${caller.key.secret}` }
        : { cookie: caller.user.cookie, origin: PUBLIC_URL }),
      'x-lakka-workspace': call.workspaceId ?? alpha.id,
      ...(call.conversationId === undefined ? {} : { 'x-lakka-conversation': call.conversationId }),
      ...call.headers,
    },
    body: JSON.stringify({
      model: (call.model ?? ok).id,
      messages: [{ role: 'user', content: 'Say hello' }],
      max_tokens: 100,
    }),
  });
  const body = (await res.json()) as {
    error?: { type: string; code: string | null };
    lakka?: Record<string, unknown>;
    choices?: { message: { content: string | null } }[];
  };
  return {
    status: res.status,
    body,
    requestId: res.headers.get('x-lakka-request-id') ?? '',
    retryAfter: res.headers.get('retry-after'),
    retryAfterMs: res.headers.get('retry-after-ms'),
  };
}

const statuses = async (caller: Caller, n: number) => {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push((await complete(caller)).status);
  return out;
};

async function reservationsFor(requestId: string): Promise<number> {
  const { rows } = await t.pool.query<{ n: number }>(
    'select count(*)::int as n from reservations where request_id = $1',
    [requestId],
  );
  return rows[0]?.n ?? 0;
}

/** The request's spans, once its root has been written. */
async function traceOf(requestId: string): Promise<SpanRow[]> {
  for (let i = 0; i < 40; i += 1) {
    await t.tracing.forceFlush();
    const rows = await listSpansForRequest(t.db, alpha.id, requestId);
    if (rows.some((r) => r.name === 'request')) return rows;
    await sleep(50);
  }
  throw new Error('the request span was never written');
}

async function conversation(user: SignedInUser): Promise<string> {
  const res = await as(t, user).post(`${ws()}/conversations`, {});
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { conversation: ConversationSummaryView }).conversation.id;
}

const DELETE_KEY = cacheScript(`return redis.call('DEL', KEYS[1])`);

beforeAll(async () => {
  mcp = await startMcpHttpServer();
  t = await createTestApp({ modelRateLimit: limit, mcpAllowedOrigins: [mcp.url] });
  fake = await startFakeProvider();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  root = await signedInUser(t, 'Root');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  alpha = (
    (
      await as(t, root).post('/api/workspaces', { name: 'Alpha', slug: `alpha-${suffix()}` })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  const provider = await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  if (provider.statusCode !== 201) throw new Error(provider.body);
  ok = await customModel('ok');
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
});

afterAll(async () => {
  await Promise.all([fake.close(), mcp.close()]);
  await t.close();
});

describe('the per-person rate limit (BG-12)', () => {
  it('BG-12: past the burst a request gets 429 with Retry-After, nothing is reserved or sent, and the trace records rate_limited', async () => {
    Object.assign(limit, { perMinute: 1, burst: 2 });
    const member = await person('Capped');
    // A cap, so a request that got past the limit would hold against it.
    const capped = await as(t, root).put(`${ws()}/budgets/members/${member.principal.id}`, {
      limitMicroUsd: String(DOLLAR),
      period: 'monthly',
    });
    expect(capped.statusCode).toBe(200);
    const model = await customModel('ok');

    for (let i = 0; i < 2; i += 1) {
      const res = await complete({ user: member }, { model });
      expect(res.status).toBe(200);
      expect(await reservationsFor(res.requestId)).toBe(1);
    }
    const refused = await complete({ user: member }, { model });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ type: 'rate_limit_error', code: 'rate_limited' });
    // At one a minute, the next token is most of a minute away.
    const seconds = Number(refused.retryAfter);
    expect(seconds).toBeGreaterThan(30);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(refused.retryAfterMs).toBe(String(seconds * 1000));
    expect(refused.body.lakka).toEqual({ retry_after_seconds: seconds });
    expect(fake.count(model.model)).toBe(2);
    expect(await reservationsFor(refused.requestId)).toBe(0);

    const spans = await traceOf(refused.requestId);
    expect(spans.find((s) => s.name === 'request')).toMatchObject({
      status: 'error',
      errorType: 'rate_limited',
    });
    const step = spans.find((s) => s.name === 'policy.rate_limit');
    expect(step).toMatchObject({ status: 'error', errorType: 'rate_limited' });
    expect(step?.attributes['lakka.rate_limit.retry_after_ms']).toBeGreaterThan(30_000);
    expect(spans.map((s) => s.name)).not.toContain('policy.reserve_budget');
    expect(spans.map((s) => s.name)).not.toContain('gateway.dispatch');
  });

  it('BG-12: 50 concurrent requests with a burst of 10 let exactly 10 through', async () => {
    Object.assign(limit, { perMinute: 1, burst: 10 });
    const member = await person('Busy');
    const model = await customModel('ok');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => complete({ user: member }, { model })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 429)).toHaveLength(40);
    expect(fake.count(model.model)).toBe(10);
  });

  it("BG-12, ID-5: a key's requests draw on its owner's bucket", async () => {
    Object.assign(limit, { perMinute: 1, burst: 3 });
    const owner = await person('Owner');
    const colleague = await person('Colleague');
    const key = (await as(t, owner).post(`${ws()}/keys`, { name: 'Script' })).json() as IssuedKey;
    expect(await statuses({ key }, 2)).toEqual([200, 200]);
    expect(await statuses({ user: owner }, 2)).toEqual([200, 429]);
    expect(await statuses({ key }, 1)).toEqual([429]);
    // Someone else has a bucket of their own.
    expect(await statuses({ user: colleague }, 1)).toEqual([200]);
  });

  it('BG-12: tokens refill at the configured rate', async () => {
    // One a second, two at most.
    Object.assign(limit, { perMinute: 60, burst: 2 });
    const member = await person('Patient');
    expect(await statuses({ user: member }, 2)).toEqual([200, 200]);
    const refused = await complete({ user: member });
    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBe('1');
    await sleep(1100);
    expect(await statuses({ user: member }, 2)).toEqual([200, 429]);
  });

  it("BG-12, TL-7: a tool loop's later rounds take no tokens, and an approval continuation takes one", async () => {
    Object.assign(limit, { perMinute: 1, burst: 1 });
    const looping = await person('Looping');
    const echo = await customModel('tool-echo', true);
    const res = await complete(
      { user: looping },
      { model: echo, conversationId: await conversation(looping) },
    );
    expect(res.status).toBe(200);
    // Two model calls, one request, one token.
    const usage = await listUsageForRequest(t.db, alpha.id, res.requestId);
    expect(usage.map((u) => u.attempt).toSorted()).toEqual([1, 2]);
    expect((await complete({ user: looping })).status).toBe(429);

    const asking = await person('Asking');
    const remove = await customModel('tool-delete', true);
    const id = await conversation(asking);
    const ran = mcp.toolCalls.length;
    const paused = await complete({ user: asking }, { model: remove, conversationId: id });
    expect(paused.status).toBe(200);
    const pending = paused.body.lakka?.['pending_approval'] as { id: string } | undefined;
    expect(pending?.id).toEqual(expect.any(String));
    // The answer is a new request: with the bucket empty, it is refused and nothing runs.
    const approved = await complete(
      { user: asking },
      { model: remove, conversationId: id, headers: { 'x-lakka-approve': pending?.id ?? '' } },
    );
    expect(approved.status).toBe(429);
    expect(mcp.toolCalls.slice(ran)).toEqual([]);
  });

  it('BG-12: a caller refused access gets 403 or 404, and their bucket is untouched', async () => {
    Object.assign(limit, { perMinute: 1, burst: 1 });
    // An instance admin is told they may not, a stranger that there is nothing there.
    const admin = await signedInUser(t, 'Admin');
    await t.pool.query('update principals set is_instance_admin = true where id = $1', [
      admin.principal.id,
    ]);
    const stranger = await signedInUser(t, 'Stranger');
    expect(await statuses({ user: admin }, 3)).toEqual([403, 403, 403]);
    expect(await statuses({ user: stranger }, 3)).toEqual([404, 404, 404]);
    for (const user of [admin, stranger]) {
      await as(t, root).put(`${ws()}/members/${user.principal.id}`, { role: 'member' });
      expect(await statuses({ user }, 2)).toEqual([200, 429]);
    }
  });

  it('BG-12, invariant 5: a flushed bucket comes back full', async () => {
    Object.assign(limit, { perMinute: 1, burst: 1 });
    const member = await person('Flushed');
    expect(await statuses({ user: member }, 2)).toEqual([200, 429]);
    await t.cache.runScript(DELETE_KEY, [`${limit.keyPrefix}${member.principal.id}`], []);
    expect(await statuses({ user: member }, 2)).toEqual([200, 429]);
  });
});

describe('failing closed (BG-12, BG-4, invariant 3)', () => {
  it('BG-12, BG-4: with Valkey unreachable, a model request is refused budget_unavailable', async () => {
    const { logger } = createLogger({ level: 'silent', service: 'model-rate-limit-test' });
    const deadCache = createCacheClient(
      { host: '127.0.0.1', port: 1, password: undefined },
      'dead',
    );
    const ctx: PipelineContext = {
      db: t.db,
      catalogue: fixedCatalogue(loadCatalogue()),
      logger,
      events: valkeyEvents(deadCache, logger),
      cache: deadCache,
      classifier: noClassifier,
      snapshots: policySnapshots({ db: t.db }),
      modelRateLimit: { perMinute: 60, burst: 10 },
    };
    const uncapped = await person('Uncapped');
    const capped = await person('Budgeted');
    await as(t, root).put(`${ws()}/budgets/members/${capped.principal.id}`, {
      limitMicroUsd: String(DOLLAR),
      period: 'monthly',
    });
    const model = await customModel('ok');
    const request = (user: SignedInUser): ModelRequest => ({
      requestId: randomUUID(),
      surface: 'api',
      workspaceId: alpha.id,
      principal: user.principal,
      request: { messages: [{ role: 'user', content: 'Say hello' }], maxOutputTokens: 100 },
      model: model.id,
      conversationId: null,
    });
    // A request no cap applies to never touches Valkey for its budget; the limit still does.
    for (const user of [uncapped, capped]) {
      const req = request(user);
      await expect(handleModelRequest(ctx, req)).rejects.toBeInstanceOf(BudgetUnavailableError);
      expect(await reservationsFor(req.requestId)).toBe(0);
    }
    expect(fake.count(model.model)).toBe(0);
    deadCache.close();
  });
});
