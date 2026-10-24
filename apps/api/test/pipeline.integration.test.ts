import { randomBytes, randomUUID } from 'node:crypto';
import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NoModelError, NotFoundError } from '@lakka/contracts';
import type { IssuedKey, ModelView, Principal, RouteView, WorkspaceView } from '@lakka/contracts';
import {
  authenticate,
  createLogger,
  handleModelRequest,
  fixedCatalogue,
  loadCatalogue,
  policySnapshots,
  startConversation,
  valkeyEvents,
} from '@lakka/core';
import type {
  ClassifierRuntime,
  ModelStream,
  Embedder,
  ModelRequest,
  PipelineContext,
} from '@lakka/core';
import { listUsageForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The single entry point for model requests (invariant 1, ADR 0047) against real Postgres and a
 * fake provider: the resolution order end to end, one decision per conversation, overrides,
 * routing off, and the rule behind every request recorded on its usage (RT-3 to RT-11, AC 12,
 * AC 13).
 *
 * The embedder counts topic words, so similarities are exact and a message with none of them
 * scores zero against every route.
 */

const TOPICS = [
  'python',
  'typescript',
  'function',
  'bug',
  'refactor',
  'compile',
  'summarize',
  'summary',
  'recap',
  'short',
  'report',
  'meeting',
];
let embedCalls = 0;
function keywordEmbedder(modelId: string): Embedder {
  return {
    modelId,
    dimensions: TOPICS.length,
    embed(text) {
      embedCalls += 1;
      const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
      const v = Float32Array.from(TOPICS, (topic) => words.filter((w) => w === topic).length);
      const norm = Math.hypot(...v);
      return Promise.resolve(norm === 0 ? v : v.map((x) => x / norm));
    },
  };
}
let embedder: Embedder | undefined = keywordEmbedder('keyword@1');
const classifier: ClassifierRuntime = {
  status: () => (embedder === undefined ? 'unavailable' : 'ready'),
  embedder: () => Promise.resolve(embedder),
};

let t: TestApp;
let fake: FakeProvider;
let root: SignedInUser;
let member: SignedInUser;
let colleague: SignedInUser;
let outsider: SignedInUser;
let auditor: SignedInUser;
let alpha: WorkspaceView;
let bravo: WorkspaceView;
let models: { default: string; cheap: string; strong: string };
let code: RouteView;
let summary: RouteView;
const exporter = new InMemorySpanExporter();
const tracer = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
}).getTracer('test');
const { logger } = createLogger({ level: 'silent', service: 'pipeline-test' });
const catalogue = fixedCatalogue(loadCatalogue());
const texts: string[] = [];

let ctx: PipelineContext;

const SUMMARIZE = 'please summarize the quarterly report';
const CODE = 'why does my python function fail';
const UNCLEAR = 'tell me about the weather tomorrow';

async function customModel(name: string, input: number, output: number): Promise<string> {
  const res = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `ok~${name}-${randomBytes(3).toString('hex')}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
      pdf: false,
      tools: false,
      structuredOutput: false,
      promptCaching: false,
      reasoning: false,
    },
    prices: {
      inputMicroUsdPerMtok: input,
      outputMicroUsdPerMtok: output,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  });
  if (res.statusCode !== 201) throw new Error(`model failed: ${res.body}`);
  return (res.json() as { model: ModelView }).model.id;
}

async function workspace(name: string): Promise<WorkspaceView> {
  const res = await as(t, root).post('/api/workspaces', {
    name,
    slug: `${name.toLowerCase()}-${randomBytes(3).toString('hex')}`,
  });
  return (res.json() as { workspace: WorkspaceView }).workspace;
}

async function join(ws: WorkspaceView, user: SignedInUser): Promise<void> {
  const res = await as(t, root).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
    role: 'member',
  });
  if (res.statusCode !== 200) throw new Error(`join failed: ${res.body}`);
}

async function addRoute(body: object): Promise<RouteView> {
  const res = await as(t, root).post(`/api/workspaces/${alpha.id}/routes`, body);
  if (res.statusCode !== 201) throw new Error(`route failed: ${res.body}`);
  return (res.json() as { route: RouteView }).route;
}

async function settings(body: {
  routingEnabled?: boolean;
  defaultModel?: string | null;
  pinnedModel?: string | null;
}): Promise<void> {
  const res = await as(t, root).put(`/api/workspaces/${alpha.id}/routing/settings`, {
    routingEnabled: true,
    defaultModel: models.default,
    pinnedModel: null,
    ...body,
  });
  if (res.statusCode !== 200) throw new Error(`settings failed: ${res.body}`);
}

function request(
  text: string,
  overrides: Partial<ModelRequest> = {},
  history: string[] = [],
): ModelRequest {
  texts.push(text, ...history);
  return {
    requestId: randomUUID(),
    surface: 'api',
    workspaceId: alpha.id,
    principal: member.principal,
    request: {
      messages: [
        ...history.map((content) => ({ role: 'user' as const, content })),
        { role: 'user', content: text },
      ],
      maxOutputTokens: 100,
    },
    model: null,
    conversationId: null,
    ...overrides,
  };
}

async function read(stream: ModelStream): Promise<string> {
  let text = '';
  for await (const e of stream) if (e.type === 'text') text += e.text;
  await stream.done;
  return text;
}

/** Runs a request to the end and returns its resolution and its first usage row. */
async function run(req: ModelRequest) {
  const response = await handleModelRequest(ctx, req);
  expect(await read(response.stream)).toBe('Hello there');
  const [usage] = await listUsageForRequest(t.db, req.workspaceId, req.requestId);
  return { ...response, usage };
}

async function conversationRow(id: string) {
  const { rows } = await t.pool.query<{ route_id: string | null; routed_model: string | null }>(
    'select route_id, routed_model from conversations where id = $1',
    [id],
  );
  return rows[0];
}

async function storedReplies(conversationId: string) {
  // The reply is stored once its stream is read to the end, as run() does.
  const { rows } = await t.pool.query<{
    routing_rule: string;
    routing_confidence: number | null;
    routing_reason: string | null;
  }>(
    `select routing_rule, routing_confidence, routing_reason from messages
      where conversation_id = $1 and role = 'assistant' order by created_at, id`,
    [conversationId],
  );
  return rows;
}

beforeAll(async () => {
  t = await createTestApp({ classifier });
  fake = await startFakeProvider();
  [root, member, colleague, outsider, auditor] = await Promise.all([
    signedInUser(t, 'Root'),
    signedInUser(t, 'Member'),
    signedInUser(t, 'Colleague'),
    signedInUser(t, 'Outsider'),
    signedInUser(t, 'Auditor'),
  ]);
  await t.pool.query('update principals set is_instance_admin = true where id = any($1)', [
    [root.principal.id, auditor.principal.id],
  ]);
  auditor = { ...auditor, principal: { ...auditor.principal, isInstanceAdmin: true } };
  alpha = await workspace('Alpha');
  bravo = await workspace('Bravo');
  await join(alpha, member);
  await join(alpha, colleague);
  await join(bravo, member);
  const provider = await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  if (provider.statusCode !== 201) throw new Error(`provider failed: ${provider.body}`);
  models = {
    default: await customModel('default', 3_000_000, 15_000_000),
    cheap: await customModel('cheap', 150_000, 600_000),
    strong: await customModel('strong', 15_000_000, 75_000_000),
  };
  code = await addRoute({
    name: 'code',
    model: models.strong,
    fallbacks: [models.default],
    signals: ['code_fence'],
    examples: [
      'fix the python function bug',
      'refactor this typescript function',
      'python compile bug',
    ],
  });
  summary = await addRoute({
    name: 'summary',
    model: models.cheap,
    examples: ['summarize this report', 'give me a short summary', 'recap the meeting'],
  });
  await settings({});
  ctx = {
    db: t.db,
    catalogue,
    logger,
    tracer,
    events: valkeyEvents(t.cache, logger),
    cache: t.cache,
    keyPrefix: `pipeline-test-${randomBytes(4).toString('hex')}:`,
    classifier,
    snapshots: policySnapshots({ db: t.db }),
    timeouts: {
      firstChunkMs: 2000,
      reasoningFirstChunkMs: 2000,
      idleMs: 2000,
      reasoningIdleMs: 2000,
    },
  };
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('the resolution order through the entry point', () => {
  it('RT-3, RT-8: a model the user chose is used, and usage records the rule', async () => {
    const { resolution, usage } = await run(request(SUMMARIZE, { model: models.strong }));
    expect(resolution.rule).toBe('explicit');
    expect(usage).toMatchObject({
      model: models.strong,
      resolutionRule: 'explicit',
      routeId: null,
      routeConfidence: null,
      defaultReason: null,
      wasOverridden: false,
    });
  });

  it('RT-3, RT-8: a deterministic signal decides without running the classifier', async () => {
    const before = embedCalls;
    const { usage } = await run(request('why does this fail?\n```\nprint(1/0)\n```'));
    expect(embedCalls).toBe(before);
    expect(usage).toMatchObject({
      model: models.strong,
      resolutionRule: 'signal',
      routeId: code.id,
      routeConfidence: null,
    });
  });

  it('RT-3, RT-5, RT-8: the classifier routes a clearly typed message, and usage records its route and confidence', async () => {
    const { usage } = await run(request(SUMMARIZE));
    expect(usage).toMatchObject({
      model: models.cheap,
      resolutionRule: 'classified',
      routeId: summary.id,
    });
    // The summary route's model is cheaper than the default, so this cleared threshold_down.
    expect(usage?.routeConfidence).toBeGreaterThan(0.35);
  });

  it('RT-6, RT-8: a message no route claims goes to the default, with the confidence it had', async () => {
    const { usage } = await run(request(UNCLEAR));
    expect(usage).toMatchObject({
      model: models.default,
      resolutionRule: 'default',
      defaultReason: 'below_threshold',
      routeId: null,
      routeConfidence: 0,
    });
  });

  it('RT-3: a workspace pin wins over signals and the classifier', async () => {
    await settings({ pinnedModel: models.cheap });
    try {
      const { usage } = await run(request('```\nconst x = 1\n```'));
      expect(usage).toMatchObject({ model: models.cheap, resolutionRule: 'pinned' });
    } finally {
      await settings({});
    }
  });
});

describe('one decision per conversation (RT-7)', () => {
  it('RT-7: a conversation is classified once, and its later messages keep the decision', async () => {
    const { id } = await startConversation(ctx, member.principal, alpha.id);
    const first = await run(request(SUMMARIZE, { conversationId: id }));
    expect(first.usage).toMatchObject({ resolutionRule: 'classified', model: models.cheap });
    expect(await conversationRow(id)).toEqual({ route_id: summary.id, routed_model: models.cheap });
    // CH-2: the stored reply keeps how sure the classifier was, for "Confidence 92%" in chat.
    const [reply] = await storedReplies(id);
    expect(reply?.routing_rule).toBe('classified');
    expect(reply?.routing_confidence).toBeCloseTo(first.usage?.routeConfidence ?? -1, 5);

    const before = embedCalls;
    const second = await run(request(CODE, { conversationId: id }, [SUMMARIZE]));
    expect(embedCalls).toBe(before);
    expect(second.usage).toMatchObject({
      resolutionRule: 'sticky',
      model: models.cheap,
      routeId: summary.id,
    });
  });

  it('RT-7: a considered "not sure" is kept; a message too short to judge is not', async () => {
    const { id } = await startConversation(ctx, member.principal, alpha.id);
    const short = await run(request('ok thanks', { conversationId: id }));
    expect(short.usage).toMatchObject({ resolutionRule: 'default', defaultReason: 'too_short' });
    expect(await conversationRow(id)).toEqual({ route_id: null, routed_model: null });

    const unclear = await run(request(UNCLEAR, { conversationId: id }));
    expect(unclear.usage).toMatchObject({ defaultReason: 'below_threshold' });
    expect((await storedReplies(id)).map((r) => r.routing_reason)).toEqual([
      'too_short',
      'below_threshold',
    ]);
    expect(await conversationRow(id)).toEqual({ route_id: null, routed_model: models.default });

    const later = await run(request(SUMMARIZE, { conversationId: id }));
    expect(later.usage).toMatchObject({ resolutionRule: 'sticky', model: models.default });
  });

  it("AC 12, RT-9: an override is recorded against the route that lost and clears the conversation's route", async () => {
    const { id } = await startConversation(ctx, member.principal, alpha.id);
    await run(request(SUMMARIZE, { conversationId: id }));

    // Choosing the model the conversation already has is not an override.
    const same = await run(request(SUMMARIZE, { conversationId: id, model: models.cheap }));
    expect(same.overridden).toBe(false);
    expect(same.usage).toMatchObject({ resolutionRule: 'explicit', wasOverridden: false });

    const override = await run(request(SUMMARIZE, { conversationId: id, model: models.strong }));
    expect(override.overridden).toBe(true);
    expect(override.usage).toMatchObject({
      model: models.strong,
      resolutionRule: 'explicit',
      wasOverridden: true,
      routeId: summary.id,
      overriddenModel: models.cheap,
    });
    expect(await conversationRow(id)).toEqual({ route_id: null, routed_model: null });

    // With the route cleared, the next message is decided afresh.
    const next = await run(request(CODE, { conversationId: id }));
    expect(next.usage).toMatchObject({ resolutionRule: 'classified', routeId: code.id });
  });
});

describe('routing is optional (AC 13)', () => {
  it('AC 13, RT-11: with routing off, every request is still served, from the default', async () => {
    const { id } = await startConversation(ctx, member.principal, alpha.id);
    await run(request(SUMMARIZE, { conversationId: id }));
    await settings({ routingEnabled: false });
    try {
      const before = embedCalls;
      for (const req of [
        request('```\nconst x = 1\n```'),
        request(SUMMARIZE),
        request(CODE, { conversationId: id }),
      ]) {
        const { usage } = await run(req);
        expect(usage).toMatchObject({
          model: models.default,
          resolutionRule: 'default',
          defaultReason: 'routing_off',
        });
      }
      expect(embedCalls).toBe(before);
    } finally {
      await settings({});
    }
  });

  it('AC 13, invariant 10: without a classifier, requests are still served, from the default', async () => {
    const saved = embedder;
    embedder = undefined;
    try {
      const { usage } = await run(request(SUMMARIZE));
      expect(usage).toMatchObject({
        model: models.default,
        resolutionRule: 'default',
        defaultReason: 'classifier_unavailable',
      });
    } finally {
      embedder = saved;
    }
  });

  it('RT-6: with nothing to choose a model and no default, the request is refused and nothing is sent', async () => {
    await settings({ routingEnabled: false, defaultModel: null });
    try {
      const req = request(SUMMARIZE);
      await expect(handleModelRequest(ctx, req)).rejects.toBeInstanceOf(NoModelError);
      expect(await listUsageForRequest(t.db, alpha.id, req.requestId)).toEqual([]);
    } finally {
      await settings({});
    }
  });

  it('NF-A3: routes compiled with another embedding model are rebuilt in the background', async () => {
    const saved = embedder;
    embedder = keywordEmbedder('keyword@2');
    try {
      const first = await run(request(SUMMARIZE));
      expect(first.usage).toMatchObject({ resolutionRule: 'default', defaultReason: 'no_routes' });
      await expect
        .poll(async () => {
          const { rows } = await t.pool.query<{ model: string }>(
            'select distinct embedding_model as model from route_centroids where workspace_id = $1',
            [alpha.id],
          );
          return rows.map((r) => r.model);
        })
        .toEqual(['keyword@2']);
      const later = await run(request(SUMMARIZE));
      expect(later.usage).toMatchObject({ resolutionRule: 'classified', routeId: summary.id });
    } finally {
      embedder = saved;
    }
    // Back to the first model, whose centroids are rebuilt the same way.
    await run(request(SUMMARIZE));
    await expect
      .poll(async () => (await run(request(SUMMARIZE))).usage?.resolutionRule)
      .toBe('classified');
  });
});

describe('who may send requests, and to which conversations', () => {
  it("AC 16: another person's conversation, or one from another workspace, does not exist for you", async () => {
    const { id } = await startConversation(ctx, member.principal, alpha.id);
    await expect(
      handleModelRequest(
        ctx,
        request(SUMMARIZE, { conversationId: id, principal: colleague.principal }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const elsewhere = await startConversation(ctx, member.principal, bravo.id);
    await expect(
      handleModelRequest(ctx, request(SUMMARIZE, { conversationId: elsewhere.id })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      handleModelRequest(ctx, request(SUMMARIZE, { conversationId: randomUUID() })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('AC 16: someone outside the workspace is told it does not exist', async () => {
    await expect(
      handleModelRequest(ctx, request(SUMMARIZE, { principal: outsider.principal })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(startConversation(ctx, outsider.principal, alpha.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('ADR 0047: an instance admin may manage a workspace but not spend its money without joining it', async () => {
    await expect(
      handleModelRequest(ctx, request(SUMMARIZE, { principal: auditor.principal })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("ID-5, invariant 2: a key acts in its owner's conversations, and a conversation it starts is its owner's", async () => {
    const res = await as(t, member).post(`/api/workspaces/${alpha.id}/keys`, { name: 'CI' });
    const issued = res.json() as IssuedKey;
    const key: Principal = await authenticate(
      { auth: t.auth, db: t.db, events: ctx.events },
      { kind: 'api_key', secret: issued.secret },
    );
    const { id } = await startConversation(ctx, member.principal, alpha.id);
    await run(request(SUMMARIZE, { conversationId: id }));
    const viaKey = await run(request(CODE, { conversationId: id, principal: key }));
    expect(viaKey.usage).toMatchObject({
      resolutionRule: 'sticky',
      principalId: key.id,
      actingUserId: member.principal.id,
    });

    const started = await startConversation(ctx, key, alpha.id);
    const { rows } = await t.pool.query<{ principal_id: string }>(
      'select principal_id from conversations where id = $1',
      [started.id],
    );
    expect(rows[0]?.principal_id).toBe(member.principal.id);
  });
});

describe('what is recorded (RT-8, NF-S5, OB-4)', () => {
  it('RT-8: each decision is traced as policy.resolve_model, with its rule, route and confidence', async () => {
    exporter.reset();
    const req = request(SUMMARIZE);
    await run(req);
    const [span] = exporter.getFinishedSpans().filter((s) => s.name === 'policy.resolve_model');
    expect(span?.attributes).toMatchObject({
      'lakka.request_id': req.requestId,
      'lakka.routing.rule': 'classified',
      'lakka.routing.route_id': summary.id,
      'lakka.routing.overridden': false,
      'lakka.model': models.cheap,
    });
    expect(span?.attributes['lakka.routing.confidence']).toBeGreaterThan(0.35);
  });

  it('NF-S5, OB-4: no message text reaches the logs or any span', () => {
    const recorded = [
      ...t.logs,
      ...exporter.getFinishedSpans().map((s) => JSON.stringify(s.attributes)),
    ].join('\n');
    for (const text of new Set(texts)) expect(recorded).not.toContain(text);
  });
});
