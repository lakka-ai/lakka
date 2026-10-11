import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@lakka/contracts';
import type { GatewayRequest, GatewayStreamEvent, ProviderKind } from '@lakka/contracts';
import { streamModelCall } from '../src/gateway/model-call.ts';
import { DEFAULT_BASE_URLS, languageModel } from '../src/gateway/providers.ts';
import type { ProviderConnection } from '../src/gateway/providers.ts';

/*
 * The real AI SDK provider packages, fed canned provider streams through an injected fetch: no
 * network. Each fixture is a provider's own wire format, including how it reports cached and
 * reasoning tokens, so these tests pin down what our normalized usage means per provider.
 */

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/providers/${name}.sse`, import.meta.url), 'utf8');

interface Captured {
  url: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(respond: () => Response) {
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return respond();
  };
  return { calls, fetch: fetchImpl };
}

const sse = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

const request: GatewayRequest = {
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Say hello.' },
  ],
  maxOutputTokens: 64,
};

async function run(connection: ProviderConnection, model: string): Promise<GatewayStreamEvent[]> {
  const events: GatewayStreamEvent[] = [];
  const signal = new AbortController().signal;
  for await (const e of streamModelCall(languageModel(connection, model), request, signal)) {
    events.push(e);
  }
  return events;
}

const text = (events: GatewayStreamEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
const finish = (events: GatewayStreamEvent[]) => events.find((e) => e.type === 'finish');

const cases: {
  kind: ProviderKind;
  model: string;
  path: string;
  auth: [string, string];
  baseURL?: string;
  /** The fixture file, when it is not named after the kind. */
  fixture?: string;
}[] = [
  {
    kind: 'anthropic',
    model: 'claude-sonnet-4-5',
    path: '/messages',
    auth: ['x-api-key', 'sk-ant-test'],
  },
  {
    kind: 'openai',
    model: 'gpt-5-mini',
    path: '/responses',
    auth: ['authorization', 'Bearer sk-openai-test'],
  },
  {
    kind: 'google',
    model: 'gemini-2.5-flash',
    path: '/models/gemini-2.5-flash:streamGenerateContent',
    auth: ['x-goog-api-key', 'google-test'],
  },
  {
    kind: 'openai-compatible',
    model: 'llama3.3',
    path: '/chat/completions',
    auth: ['authorization', 'Bearer local-test'],
    baseURL: 'http://ollama.internal:11434/v1',
  },
  {
    kind: 'deepseek',
    model: 'deepseek-v4-pro',
    path: '/chat/completions',
    auth: ['authorization', 'Bearer sk-deepseek-test'],
  },
  ...(['moonshot', 'qwencloud', 'xiaomi-mimo', 'zai'] as const).map((kind) => ({
    kind,
    model: 'm',
    path: '/chat/completions',
    auth: ['authorization', `Bearer ${kind}-test`] as [string, string],
    fixture: 'openai-compatible',
  })),
];

const keyFor = (auth: [string, string]) => auth[1].replace(/^Bearer /, '');

describe('provider connections (ADR 0036)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  for (const c of cases) {
    it(`PR-4: ${c.kind} streams text through its own protocol, to the configured address with our key`, async () => {
      // Environment variables the SDK would otherwise fall back to must have no effect.
      process.env['OPENAI_BASE_URL'] = 'https://attacker.example/v1';
      process.env['ANTHROPIC_BASE_URL'] = 'https://attacker.example/v1';
      process.env['OPENAI_API_KEY'] = 'env-key';
      process.env['ANTHROPIC_API_KEY'] = 'env-key';
      process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = 'env-key';
      const fake = fakeFetch(() => sse(fixture(c.fixture ?? c.kind)));
      const events = await run(
        {
          kind: c.kind,
          apiKey: keyFor(c.auth),
          ...(c.baseURL === undefined ? {} : { baseURL: c.baseURL, name: 'ollama' }),
          fetch: fake.fetch,
        },
        c.model,
      );
      expect(text(events)).toBe('Hello there');
      expect(finish(events)).toMatchObject({ type: 'finish', finishReason: 'stop' });
      expect(fake.calls).toHaveLength(1);
      const base =
        c.baseURL ?? DEFAULT_BASE_URLS[c.kind as Exclude<ProviderKind, 'openai-compatible'>];
      expect(fake.calls[0]?.url.startsWith(`${base}${c.path}`)).toBe(true);
      expect(fake.calls[0]?.headers.get(c.auth[0])).toBe(c.auth[1]);
      expect(JSON.stringify(fake.calls[0]?.body)).toContain('Say hello.');
    });
  }

  it('anthropic: cache reads and writes are reported apart from uncached input', async () => {
    const fake = fakeFetch(() => sse(fixture('anthropic')));
    const events = await run({ kind: 'anthropic', apiKey: 'k', fetch: fake.fetch }, 'm');
    expect(finish(events)).toMatchObject({
      usage: {
        inputTokens: 2112,
        uncachedInputTokens: 12,
        cacheReadTokens: 2000,
        cacheWriteTokens: 100,
        outputTokens: 7,
      },
    });
  });

  it('openai: cached tokens are part of input_tokens and split out; reasoning is part of output', async () => {
    const fake = fakeFetch(() => sse(fixture('openai')));
    const events = await run({ kind: 'openai', apiKey: 'k', fetch: fake.fetch }, 'gpt-5-mini');
    expect(finish(events)).toMatchObject({
      usage: {
        inputTokens: 2100,
        uncachedInputTokens: 100,
        cacheReadTokens: 2000,
        outputTokens: 40,
        reasoningTokens: 30,
      },
    });
  });

  it('google: cached content and thoughts are reported', async () => {
    const fake = fakeFetch(() => sse(fixture('google')));
    const events = await run(
      { kind: 'google', apiKey: 'k', fetch: fake.fetch },
      'gemini-2.5-flash',
    );
    expect(finish(events)).toMatchObject({
      usage: { inputTokens: 1500, uncachedInputTokens: 500, cacheReadTokens: 1000 },
    });
    const usage = finish(events);
    expect(usage?.type === 'finish' ? usage.usage.reasoningTokens : undefined).toBe(50);
  });

  it('openai-compatible: usage is requested on the stream and cached tokens are split out', async () => {
    const fake = fakeFetch(() => sse(fixture('openai-compatible')));
    const events = await run(
      { kind: 'openai-compatible', baseURL: 'http://vllm.internal/v1', fetch: fake.fetch },
      'llama3.3',
    );
    expect(fake.calls[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    // No key configured: no Authorization header at all, and none taken from the environment.
    expect(fake.calls[0]?.headers.get('authorization')).toBeNull();
    expect(finish(events)).toMatchObject({
      usage: { inputTokens: 50, uncachedInputTokens: 18, cacheReadTokens: 32, outputTokens: 8 },
    });
  });

  it('PR-4: deepseek reports cache reads and reasoning on the stream, and shows its reasoning', async () => {
    const fake = fakeFetch(() => sse(fixture('deepseek')));
    const events = await run(
      { kind: 'deepseek', apiKey: 'k', fetch: fake.fetch },
      'deepseek-v4-pro',
    );
    expect(fake.calls[0]?.body).toMatchObject({
      model: 'deepseek-v4-pro',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(events.filter((e) => e.type === 'reasoning')).toEqual([
      { type: 'reasoning', text: 'A greeting.' },
    ]);
    expect(text(events)).toBe('Hello there');
    expect(finish(events)).toMatchObject({
      usage: {
        inputTokens: 64,
        uncachedInputTokens: 16,
        cacheReadTokens: 48,
        outputTokens: 12,
        reasoningTokens: 4,
      },
    });
  });

  it('an HTTP error rejects the first read, with the status and headers kept for classification', async () => {
    const fake = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'slow down' },
          }),
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '7' },
          },
        ),
    );
    const stream = streamModelCall(
      languageModel({ kind: 'anthropic', apiKey: 'k', fetch: fake.fetch }, 'm'),
      request,
      new AbortController().signal,
    );
    const error: unknown = await stream.next().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ statusCode: 429, responseHeaders: { 'retry-after': '7' } });
  });

  it('refuses a first-party connection without a key, and a compatible one without an address', () => {
    expect(() => languageModel({ kind: 'openai', apiKey: ' ' }, 'gpt-5')).toThrow(ConfigError);
    expect(() => languageModel({ kind: 'zai' }, 'glm-5')).toThrow(ConfigError);
    expect(() => languageModel({ kind: 'openai-compatible' }, 'llama')).toThrow(ConfigError);
  });
});
