import { randomBytes, randomUUID } from 'node:crypto';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContentFilteredError, ProviderAuthError } from '@lakka/contracts';
import type { ModelView } from '@lakka/contracts';
import { createLogger, dispatch, fixedCatalogue, loadCatalogue } from '@lakka/core';
import type { DispatchContext, DispatchRequest } from '@lakka/core';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Tracing of model calls (OB-1, OB-2, OB-4, ADR 0041): a gateway.dispatch span per request and
 * a GenAI chat span per attempt, with counts, cost and outcomes, and never any content.
 */

let t: TestApp;
let fake: FakeProvider;
let admin: SignedInUser;
const exporter = new InMemorySpanExporter();
const tracer = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
}).getTracer('test');
const { logger } = createLogger({ level: 'silent', service: 'tracing-test' });
const catalogue = fixedCatalogue(loadCatalogue());
const PROMPT = 'Summarize the confidential merger memo';

const ctx = (): DispatchContext => ({
  db: t.db,
  catalogue,
  logger,
  tracer,
  timeouts: { firstChunkMs: 400, reasoningFirstChunkMs: 400, idleMs: 400, reasoningIdleMs: 400 },
  attemptsPerModel: 2,
  backoffMs: () => 5,
});

async function model(scenario: string): Promise<string> {
  const res = await as(t, admin).post('/api/models/custom', {
    provider: 'fake',
    model: `${scenario}~${randomBytes(3).toString('hex')}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
      pdf: false,
      tools: false,
      structuredOutput: false,
      promptCaching: true,
      reasoning: false,
    },
    prices: {
      inputMicroUsdPerMtok: 1_000_000,
      outputMicroUsdPerMtok: 2_000_000,
      cacheReadMicroUsdPerMtok: 100_000,
      cacheWriteMicroUsdPerMtok: null,
    },
  });
  return (res.json() as { model: ModelView }).model.id;
}

const request = (candidates: string[], extra: Partial<DispatchRequest> = {}): DispatchRequest => ({
  requestId: randomUUID(),
  surface: 'chat',
  workspaceId: randomUUID(),
  principal: admin.principal,
  request: {
    messages: [{ role: 'user', content: PROMPT }],
    maxOutputTokens: 100,
    temperature: 0.3,
  },
  candidates,
  ...extra,
  routing: {
    rule: 'explicit',
    routeId: null,
    confidence: null,
    defaultReason: null,
    overriddenModel: null,
    budgetFallbackFrom: null,
  },
});

const byName = (prefix: string) =>
  exporter.getFinishedSpans().filter((s) => s.name.startsWith(prefix));
const only = (spans: ReadableSpan[]): ReadableSpan => {
  expect(spans).toHaveLength(1);
  return spans[0] as ReadableSpan;
};

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  admin = await signedInUser(t, 'Admin');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  await as(t, admin).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
});

beforeEach(() => exporter.reset());

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('dispatch spans', () => {
  it('OB-1, OB-2: a request is a dispatch span with one GenAI chat span, carrying usage and cost', async () => {
    const ref = await model('ok');
    const r = request([ref]);
    const stream = await dispatch(ctx(), r);
    for await (const _ of stream) void _;
    await stream.done;

    const parent = only(byName('gateway.dispatch'));
    const chat = only(byName('chat '));
    expect(chat.name).toBe(`chat ${ref.slice('fake:'.length)}`);
    expect(chat.kind).toBe(SpanKind.CLIENT);
    expect(chat.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(chat.status.code).toBe(SpanStatusCode.OK);
    expect(chat.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'fake',
      'gen_ai.request.model': ref.slice('fake:'.length),
      'gen_ai.request.max_tokens': 100,
      'gen_ai.request.temperature': 0.3,
      'gen_ai.request.stream': true,
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 50,
      'gen_ai.usage.output_tokens': 8,
      'gen_ai.usage.cache_read.input_tokens': 32,
      'lakka.cost_micro_usd': 38,
      'lakka.outcome': 'completed',
      'lakka.attempt': 1,
    });
    expect(chat.attributes['gen_ai.response.time_to_first_chunk']).toBeGreaterThan(0);
    expect(parent.attributes).toMatchObject({
      'lakka.request_id': r.requestId,
      'lakka.surface': 'chat',
      'lakka.model': ref,
      'lakka.attempts': 1,
      'lakka.outcome': 'completed',
      'lakka.cost_micro_usd': 38,
    });
  });

  it('OB-1: every attempt is its own span, a failed one marked with why', async () => {
    const stream = await dispatch(ctx(), request([await model('flaky-1-status-503')]));
    for await (const _ of stream) void _;
    await stream.done;
    const chats = byName('chat ').toSorted(
      (a, b) => Number(a.attributes['lakka.attempt']) - Number(b.attributes['lakka.attempt']),
    );
    expect(
      chats.map((s) => [
        s.attributes['lakka.attempt'],
        s.status.code,
        s.attributes['error.type'] ?? null,
      ]),
    ).toEqual([
      [1, SpanStatusCode.ERROR, 'overloaded'],
      [2, SpanStatusCode.OK, null],
    ]);
    expect(chats[0]?.attributes['lakka.provider.http_status']).toBe(503);
    expect(only(byName('gateway.dispatch')).attributes['lakka.attempts']).toBe(2);
  });

  it('a refused request ends both spans with the error type, and skipped candidates are recorded', async () => {
    const refused = await model('status-401');
    await expect(dispatch(ctx(), request([refused, 'fake:not-registered']))).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
    const parent = only(byName('gateway.dispatch'));
    expect(parent.status.code).toBe(SpanStatusCode.ERROR);
    expect(parent.attributes['error.type']).toBe('provider_auth_failed');
    expect(parent.events.map((e) => [e.name, e.attributes?.['error.type']])).toEqual([
      ['lakka.candidate_skipped', 'unknown_model'],
    ]);
    expect(only(byName('chat ')).attributes['error.type']).toBe('auth');
  });

  it('nests under the surface request span it is given', async () => {
    const root = tracer.startSpan('request');
    const stream = await dispatch(
      ctx(),
      request([await model('ok')], { traceContext: trace.setSpan(context.active(), root) }),
    );
    for await (const _ of stream) void _;
    await stream.done;
    root.end();
    expect(only(byName('gateway.dispatch')).parentSpanContext?.spanId).toBe(
      root.spanContext().spanId,
    );
  });

  it('OB-4: no span, attribute, event or status carries prompt or response text', async () => {
    const stream = await dispatch(ctx(), request([await model('flaky-1-status-503')]));
    for await (const _ of stream) void _;
    await stream.done;
    await expect(dispatch(ctx(), request([await model('content-filter')]))).rejects.toBeInstanceOf(
      ContentFilteredError,
    );
    const dump = JSON.stringify(
      exporter.getFinishedSpans().map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
      })),
    );
    expect(exporter.getFinishedSpans().length).toBeGreaterThan(3);
    for (const content of [PROMPT, 'merger', 'Hello there', 'Hello', 'content policy']) {
      expect(dump).not.toContain(content);
    }
  });
});
