import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContentFilteredError,
  ContextTooLongError,
  OutputTooLongError,
  ProviderAuthError,
  ProviderBillingError,
  ProviderNotConfiguredError,
  ProviderRequestRejectedError,
  StreamInterruptedError,
  UnknownModelError,
  UpstreamUnavailableError,
} from '@lakka/contracts';
import type { GatewayStreamEvent, ModelView, ProviderConfigView } from '@lakka/contracts';
import { createLogger, dispatch, fixedCatalogue, loadCatalogue } from '@lakka/core';
import type { DispatchContext, DispatchedStream, DispatchRequest } from '@lakka/core';
import { listUsageForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * The gateway's dispatch (ADR 0040) against real Postgres and a fake provider over
 * real HTTP that fails in the ways real providers do. This is where M2's exit criteria are
 * proven: correct cost records, and failover exactly as documented when a provider dies before
 * or after the first chunk.
 */

let t: TestApp;
let fake: FakeProvider;
let admin: SignedInUser;
let fakeConfig: ProviderConfigView;
const workspaceId = randomUUID();
const catalogue = fixedCatalogue(loadCatalogue());
const logs: string[] = [];
const { logger } = createLogger({
  level: 'debug',
  service: 'dispatch-test',
  destination: { write: (line: string) => void logs.push(line) },
});

const WINDOW_MS = 400;
const ctx = (overrides: Partial<DispatchContext> = {}): DispatchContext => ({
  db: t.db,
  catalogue,
  logger,
  timeouts: {
    firstChunkMs: WINDOW_MS,
    reasoningFirstChunkMs: WINDOW_MS,
    idleMs: WINDOW_MS,
    reasoningIdleMs: WINDOW_MS,
  },
  attemptsPerModel: 2,
  maxRetryAfterMs: 1500,
  backoffMs: () => 5,
  ...overrides,
});

const tag = () => randomBytes(3).toString('hex');

/** Registers a priced custom model and returns its reference. */
async function model(
  provider: string,
  scenario: string,
  limits: {
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoning?: boolean;
    vision?: boolean;
  } = {},
): Promise<string> {
  const res = await as(t, admin).post('/api/models/custom', {
    provider,
    model: `${scenario}~${tag()}`,
    contextWindow: limits.contextWindow ?? 100_000,
    maxOutputTokens: limits.maxOutputTokens ?? 4096,
    capabilities: {
      vision: limits.vision ?? false,
      pdf: false,
      tools: false,
      structuredOutput: false,
      promptCaching: true,
      reasoning: limits.reasoning ?? false,
    },
    prices: {
      inputMicroUsdPerMtok: 1_000_000,
      outputMicroUsdPerMtok: 2_000_000,
      cacheReadMicroUsdPerMtok: 100_000,
      cacheWriteMicroUsdPerMtok: 1_250_000,
    },
  });
  if (res.statusCode !== 201) throw new Error(`model failed: ${res.body}`);
  return (res.json() as { model: ModelView }).model.id;
}

const providerModel = (ref: string) => ref.slice(ref.indexOf(':') + 1);

function request(candidates: string[], extra: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    requestId: randomUUID(),
    surface: 'api',
    workspaceId,
    principal: admin.principal,
    request: { messages: [{ role: 'user', content: 'Say hello' }], maxOutputTokens: 100 },
    candidates,
    routing: {
      rule: 'explicit',
      routeId: null,
      confidence: null,
      defaultReason: null,
      overriddenModel: null,
      budgetFallbackFrom: null,
    },
    ...extra,
  };
}

/** A request with an image, for the capability checks (CH-5). */
const withImage = (candidates: string[]) =>
  request(candidates, {
    request: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this picture?' },
            { type: 'file', mediaType: 'image/png', data: Buffer.from('png').toString('base64') },
          ],
        },
      ],
      maxOutputTokens: 100,
    },
  });

async function read(
  stream: DispatchedStream,
): Promise<{ text: string; events: GatewayStreamEvent[] }> {
  const events: GatewayStreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return { text: events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join(''), events };
}

const usage = (r: DispatchRequest) => listUsageForRequest(t.db, workspaceId, r.requestId);

async function addProvider(body: object): Promise<ProviderConfigView> {
  const res = await as(t, admin).post('/api/providers', body);
  if (res.statusCode !== 201) throw new Error(`provider failed: ${res.body}`);
  return (res.json() as { provider: ProviderConfigView }).provider;
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  admin = await signedInUser(t, 'Admin');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  fakeConfig = await addProvider({
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
    apiKey: 'fake-provider-key',
  });
  await addProvider({ kind: 'openai-compatible', name: 'other', baseUrl: `${fake.url}/openai/v1` });
  await addProvider({
    kind: 'anthropic',
    apiKey: 'anthropic-provider-key',
    baseUrl: `${fake.url}/anthropic/v1`,
  });
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('dispatch: the happy path and cost records', () => {
  it('M2 exit: a completed request has a correct cost record, from the provider-reported usage', async () => {
    const ref = await model('fake', 'ok');
    const r = request([ref]);
    const stream = await dispatch(ctx(), r);
    expect((await read(stream)).text).toBe('Hello there');
    expect(await stream.done).toMatchObject({
      model: ref,
      attempts: 1,
      outcome: 'completed',
      costMicroUsd: 38n,
    });
    const [row] = await usage(r);
    // 18 uncached * $1/M + 32 cached * $0.10/M + 8 output * $2/M = 37.2 micro-USD, rounded up.
    expect(row).toMatchObject({
      outcome: 'completed',
      attempt: 1,
      inputTokens: 50,
      uncachedInputTokens: 18,
      cacheReadTokens: 32,
      outputTokens: 8,
      usageEstimated: false,
      costMicroUsd: 38n,
      providerConfigId: fakeConfig.id,
      principalId: admin.principal.id,
      surface: 'api',
    });
    expect(row?.ttftMs).not.toBeNull();
    // The output limit is always sent, so the provider never produces more than was estimated.
    const sent = fake.requests.find((q) => q.model === providerModel(ref));
    expect(sent?.body['max_tokens']).toBe(100);
    expect(sent?.authorization).toBe('Bearer fake-provider-key');
  });

  it('M2 exit: the Anthropic protocol, with cache reads and writes priced', async () => {
    const ref = await model('anthropic', 'ok');
    const r = request([ref]);
    expect((await read(await dispatch(ctx(), r))).text).toBe('Hello there');
    const [row] = await usage(r);
    // 12 * $1/M + 2000 * $0.10/M + 100 * $1.25/M + 7 * $2/M = 351 micro-USD.
    expect(row).toMatchObject({
      uncachedInputTokens: 12,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
      outputTokens: 7,
      costMicroUsd: 351n,
    });
  });

  it('BG-8: a provider that reports no usage is billed from the pessimistic estimate, and says so', async () => {
    const r = request([await model('fake', 'no-usage')]);
    await read(await dispatch(ctx(), r));
    const [row] = await usage(r);
    expect(row).toMatchObject({ outcome: 'completed', usageEstimated: true });
    expect(row?.costMicroUsd).toBeGreaterThan(0n);
  });
});

describe('dispatch: failures before the first chunk (invariant 6)', () => {
  it('retries a 503 on the same model; an HTTP error is not billed', async () => {
    const ref = await model('fake', 'flaky-1-status-503');
    const r = request([ref]);
    const stream = await dispatch(ctx(), r);
    await read(stream);
    expect(stream.attempts).toBe(2);
    expect(fake.count(providerModel(ref))).toBe(2);
    expect((await usage(r)).map((u) => [u.attempt, u.outcome])).toEqual([[2, 'completed']]);
  });

  it('waits out a short Retry-After before retrying', async () => {
    const ref = await model('fake', 'flaky-1-status-429-ra1');
    const started = performance.now();
    await read(await dispatch(ctx(), request([ref])));
    expect(performance.now() - started).toBeGreaterThanOrEqual(950);
    expect(fake.count(providerModel(ref))).toBe(2);
  });

  it('fails over instead of waiting out a long Retry-After', async () => {
    const limited = await model('fake', 'status-429-ra60');
    const backup = await model('fake', 'ok');
    const started = performance.now();
    const stream = await dispatch(ctx(), request([limited, backup]));
    await read(stream);
    expect(stream.model.id).toBe(backup);
    expect(performance.now() - started).toBeLessThan(900);
    expect(fake.count(providerModel(limited))).toBe(1);
  });

  it('D8: a stalled first chunk is abandoned, retried, and its possible cost recorded', async () => {
    const ref = await model('fake', 'flaky-1-stall');
    const r = request([ref]);
    const stream = await dispatch(ctx(), r);
    expect((await read(stream)).text).toBe('Hello there');
    const rows = await usage(r);
    expect(rows.map((u) => [u.attempt, u.outcome, u.usageEstimated])).toEqual([
      [1, 'abandoned', true],
      [2, 'completed', false],
    ]);
    expect(rows[0]?.costMicroUsd).toBeGreaterThan(0n);
    expect(rows[0]?.outputTokens).toBe(0);
  });

  it('M2 exit: a provider killed before the first chunk is retried without the client noticing', async () => {
    const ref = await model('fake', 'flaky-1-drop-before-first');
    const r = request([ref]);
    const stream = await dispatch(ctx(), r);
    expect((await read(stream)).text).toBe('Hello there');
    expect((await usage(r)).map((u) => u.outcome)).toEqual(['abandoned', 'completed']);
  });

  it('retries an error event inside an accepted stream (Anthropic overloaded_error)', async () => {
    const ref = await model('anthropic', 'flaky-1-error-event');
    const stream = await dispatch(ctx(), request([ref]));
    expect((await read(stream)).text).toBe('Hello there');
    expect(stream.attempts).toBe(2);
  });

  it('gives up with upstream_unavailable once every attempt on every candidate has failed', async () => {
    const a = await model('fake', 'status-503');
    const b = await model('fake', 'status-503');
    const r = request([a, b]);
    await expect(dispatch(ctx(), r)).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(fake.count(providerModel(a))).toBe(2);
    expect(fake.count(providerModel(b))).toBe(2);
    expect(await usage(r)).toEqual([]);
  });

  it('CH-7: giving up names the provider, and says how long a rate limit asked to wait', async () => {
    const down = await model('fake', 'status-503');
    await expect(dispatch(ctx(), request([down]))).rejects.toMatchObject({
      code: 'upstream_unavailable',
      provider: 'fake',
      rateLimited: false,
      retryAfterSeconds: null,
    });
    const limited = await model('fake', 'status-429-ra60');
    await expect(dispatch(ctx(), request([limited]))).rejects.toMatchObject({
      code: 'upstream_unavailable',
      provider: 'fake',
      rateLimited: true,
      retryAfterSeconds: 60,
    });
  });

  it('CH-7: a model its provider does not know is failed over at once, not retried', async () => {
    const unknown = await model('fake', 'no-such-model');
    const backup = await model('fake', 'ok');
    const stream = await dispatch(ctx(), request([unknown, backup]));
    await read(stream);
    expect(stream.model.id).toBe(backup);
    expect(fake.count(providerModel(unknown))).toBe(1);
  });

  it('CH-7: when every candidate is unknown to its provider, the error names the model', async () => {
    const a = await model('fake', 'no-such-model');
    const b = await model('fake', 'no-such-model');
    const r = request([a, b]);
    await expect(dispatch(ctx(), r)).rejects.toMatchObject({
      code: 'provider_model_not_found',
      provider: 'fake',
      model: b,
    });
    expect(fake.count(providerModel(a))).toBe(1);
    expect(fake.count(providerModel(b))).toBe(1);
    expect(await usage(r)).toEqual([]);
  });

  it('CH-7: an unknown model next to one that is down stays upstream_unavailable', async () => {
    const unknown = await model('fake', 'no-such-model');
    const down = await model('fake', 'status-503');
    await expect(dispatch(ctx(), request([unknown, down]))).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
    await expect(dispatch(ctx(), request([down, unknown]))).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
  });

  it('fails over to a model with a larger window when the input overflows', async () => {
    const small = await model('fake', 'context-overflow');
    const large = await model('fake', 'ok');
    const stream = await dispatch(ctx(), request([small, large]));
    await read(stream);
    expect(stream.model.id).toBe(large);
    expect(fake.count(providerModel(small))).toBe(1);
    await expect(
      dispatch(ctx(), request([await model('fake', 'context-overflow')])),
    ).rejects.toBeInstanceOf(ContextTooLongError);
  });
});

describe('dispatch: terminal errors are not retried and not failed over', () => {
  for (const [scenario, error] of [
    ['status-401', ProviderAuthError],
    ['content-filter', ContentFilteredError],
    ['bad-request', ProviderRequestRejectedError],
    ['status-402', ProviderBillingError],
    ['no-credit', ProviderBillingError],
  ] as const) {
    it(`${scenario} stops at once, even with a fallback`, async () => {
      const failing = await model('fake', scenario);
      const fallback = await model('fake', 'ok');
      await expect(dispatch(ctx(), request([failing, fallback]))).rejects.toBeInstanceOf(error);
      expect(fake.count(providerModel(failing))).toBe(1);
      expect(fake.count(providerModel(fallback))).toBe(0);
    });
  }

  it('CH-7: a billing refusal names the provider, from either protocol', async () => {
    for (const provider of ['fake', 'anthropic']) {
      await expect(
        dispatch(ctx(), request([await model(provider, 'no-credit')])),
      ).rejects.toMatchObject({ code: 'provider_billing', provider });
    }
  });
});

describe('dispatch: failures after the first chunk (invariant 6)', () => {
  it('M2 exit: a provider killed mid-stream surfaces an error, is never failed over, and partial usage is recorded', async () => {
    const dying = await model('fake', 'drop-after-2');
    const fallback = await model('fake', 'ok');
    const r = request([dying, fallback]);
    const stream = await dispatch(ctx(), r);
    const events: GatewayStreamEvent[] = [];
    const error: unknown = await (async () => {
      for await (const e of stream) events.push(e);
    })().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StreamInterruptedError);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(2);
    expect(fake.count(providerModel(fallback))).toBe(0);
    expect(await stream.done).toMatchObject({ outcome: 'interrupted' });
    const [row] = await usage(r);
    expect(row).toMatchObject({ outcome: 'interrupted', usageEstimated: true });
    expect(row?.outputTokens).toBeGreaterThan(0);
  });

  it('ends a stream that goes quiet, as interrupted', async () => {
    const r = request([await model('fake', 'idle-after-1')]);
    const stream = await dispatch(ctx(), r);
    await expect(read(stream)).rejects.toBeInstanceOf(StreamInterruptedError);
    expect((await usage(r))[0]?.outcome).toBe('interrupted');
  });

  it('invariant 4: a client that goes away mid-stream is recorded as aborted, with partial usage', async () => {
    const controller = new AbortController();
    const r = request([await model('fake', 'slow')], { signal: controller.signal });
    const stream = await dispatch(ctx(), r);
    let seen = 0;
    const error: unknown = await (async () => {
      for await (const e of stream) {
        if (e.type === 'text' && ++seen === 3) controller.abort(new Error('client went away'));
      }
    })().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(seen).toBeLessThan(40);
    const [row] = await usage(r);
    expect(row).toMatchObject({ outcome: 'aborted', usageEstimated: true });
  });

  it('invariant 4: a client that goes away before the first chunk still has the attempt recorded', async () => {
    const controller = new AbortController();
    const r = request([await model('fake', 'stall')], { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('client went away')), 100);
    await expect(dispatch(ctx({ timeouts: { firstChunkMs: 5000 } }), r)).rejects.toThrow(
      'client went away',
    );
    expect((await usage(r)).map((u) => u.outcome)).toEqual(['aborted']);
  });

  it('a reader that stops early is recorded as aborted', async () => {
    const r = request([await model('fake', 'slow')]);
    const stream = await dispatch(ctx(), r);
    for await (const e of stream) {
      if (e.type === 'text') break;
    }
    expect(await stream.done).toMatchObject({ outcome: 'aborted' });
  });
});

describe('dispatch: checks before anything is sent', () => {
  it('skips a candidate whose window cannot take the input, without calling it', async () => {
    const tiny = await model('fake', 'ok', { contextWindow: 5 });
    const roomy = await model('fake', 'ok');
    const stream = await dispatch(ctx(), request([tiny, roomy]));
    await read(stream);
    expect(stream.model.id).toBe(roomy);
    expect(fake.count(providerModel(tiny))).toBe(0);
    await expect(dispatch(ctx(), request([tiny]))).rejects.toBeInstanceOf(ContextTooLongError);
  });

  it('skips a candidate that cannot produce the requested output', async () => {
    const short = await model('fake', 'ok', { maxOutputTokens: 50 });
    await expect(dispatch(ctx(), request([short]))).rejects.toBeInstanceOf(OutputTooLongError);
    expect(fake.count(providerModel(short))).toBe(0);
  });

  it('D9: fails over within the provider family only, unless crossing is allowed', async () => {
    const down = await model('fake', 'status-503');
    const elsewhere = await model('other', 'ok');
    await expect(dispatch(ctx(), request([down, elsewhere]))).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
    expect(fake.count(providerModel(elsewhere))).toBe(0);
    const stream = await dispatch(ctx(), request([down, elsewhere], { allowCrossProvider: true }));
    await read(stream);
    expect(stream.model.id).toBe(elsewhere);
  });

  it('PR-8, BG-4: refuses a provider with no credential and a model with no price', async () => {
    const unconfigured = await model('nokey', 'ok');
    await expect(dispatch(ctx(), request([unconfigured]))).rejects.toBeInstanceOf(
      ProviderNotConfiguredError,
    );
    await expect(dispatch(ctx(), request(['fake:never-registered']))).rejects.toBeInstanceOf(
      UnknownModelError,
    );
  });
});

describe('dispatch: files the model cannot read (CH-5)', () => {
  it('CH-5: a model without vision is passed over for one that can see, before anything is sent', async () => {
    const blind = await model('fake', 'ok');
    const seeing = await model('fake', 'ok', { vision: true });
    const stream = await dispatch(ctx(), withImage([blind, seeing]));
    expect(stream.model.id).toBe(seeing);
    expect((await read(stream)).text).toBe('Hello there');
    expect(fake.count(providerModel(blind))).toBe(0);
    expect(fake.count(providerModel(seeing))).toBe(1);
  });

  it('CH-5: when no candidate can read the file, the request is refused with the reason and nothing is sent', async () => {
    const blind = await model('fake', 'ok');
    await expect(dispatch(ctx(), withImage([blind]))).rejects.toMatchObject({
      code: 'unsupported_input',
      message: 'this model cannot read images',
    });
    expect(fake.count(providerModel(blind))).toBe(0);
  });
});

describe('dispatch: secrets and content stay out of logs', () => {
  it('NF-S5: no prompt, response or provider key is logged', () => {
    const text = logs.join('\n');
    expect(text).toContain('dispatch.attempt_failed');
    for (const secret of [
      'Say hello',
      'Hello there',
      'fake-provider-key',
      'anthropic-provider-key',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(t.logs.join('\n')).not.toContain('fake-provider-key');
  });
});
