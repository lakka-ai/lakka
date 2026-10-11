import { describe, expect, it } from 'vitest';
import { probeProvider } from '../src/gateway/probe.ts';
import type { ProviderConnection } from '../src/gateway/providers.ts';

function fake(status: number | 'throw') {
  const seen: { url: string; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    });
    if (status === 'throw') throw new TypeError('fetch failed');
    return new Response('{"secret":"ignored"}', { status });
  };
  return { seen, fetch: fetchImpl };
}

const run = async (status: number | 'throw') =>
  probeProvider({ kind: 'openai', apiKey: 'k' }, { fetch: fake(status).fetch });

describe('probeProvider (PR-1)', () => {
  const cases: [ProviderConnection, string, [string, string]][] = [
    [
      { kind: 'anthropic', apiKey: 'a' },
      'https://api.anthropic.com/v1/models?limit=1',
      ['x-api-key', 'a'],
    ],
    [
      { kind: 'openai', apiKey: 'o' },
      'https://api.openai.com/v1/models',
      ['authorization', 'Bearer o'],
    ],
    [
      { kind: 'google', apiKey: 'g' },
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      ['x-goog-api-key', 'g'],
    ],
    [
      { kind: 'deepseek', apiKey: 'd' },
      'https://api.deepseek.com/models',
      ['authorization', 'Bearer d'],
    ],
    [
      { kind: 'moonshot', apiKey: 'm' },
      'https://api.moonshot.ai/v1/models',
      ['authorization', 'Bearer m'],
    ],
    [
      { kind: 'qwencloud', apiKey: 'q' },
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
      ['authorization', 'Bearer q'],
    ],
    [
      { kind: 'xiaomi-mimo', apiKey: 'x' },
      'https://api.xiaomimimo.com/v1/models',
      ['authorization', 'Bearer x'],
    ],
    [
      { kind: 'zai', apiKey: 'z' },
      'https://api.z.ai/api/paas/v4/models',
      ['authorization', 'Bearer z'],
    ],
    [
      { kind: 'openai-compatible', apiKey: 'c', baseURL: 'http://vllm.internal/v1' },
      'http://vllm.internal/v1/models',
      ['authorization', 'Bearer c'],
    ],
  ];

  for (const [connection, url, [header, value]] of cases) {
    it(`lists ${connection.kind} models, a free call, without following redirects`, async () => {
      const f = fake(200);
      expect(await probeProvider(connection, { fetch: f.fetch })).toEqual({
        status: 'ok',
        httpStatus: 200,
      });
      expect(f.seen[0]).toMatchObject({ url, redirect: 'manual' });
      expect(f.seen[0]?.headers.get(header)).toBe(value);
    });
  }

  it('classifies refused keys, other errors, redirects and unreachable addresses', async () => {
    expect(await run(401)).toEqual({ status: 'auth_failed', httpStatus: 401 });
    expect(await run(403)).toEqual({ status: 'auth_failed', httpStatus: 403 });
    expect(await run(500)).toEqual({ status: 'error', httpStatus: 500 });
    expect(await run(302)).toEqual({ status: 'error', httpStatus: 302 });
    expect(await run('throw')).toEqual({ status: 'unreachable', httpStatus: null });
  });

  it('sends no Authorization header to a compatible endpoint without a key', async () => {
    const f = fake(200);
    await probeProvider(
      { kind: 'openai-compatible', baseURL: 'http://ollama.internal:11434/v1' },
      { fetch: f.fetch },
    );
    expect(f.seen[0]?.headers.has('authorization')).toBe(false);
  });
});
