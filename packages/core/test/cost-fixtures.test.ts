import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GatewayStreamEvent, ProviderKind, TokenUsage } from '@lakka/contracts';
import { priceUsage } from '../src/costs/pricing.ts';
import type { PricedModel } from '../src/costs/pricing.ts';
import { streamModelCall } from '../src/gateway/model-call.ts';
import { languageModel } from '../src/gateway/providers.ts';
import { loadCatalogue } from '../src/models/catalogue.ts';

/*
 * M2 exit criterion 3 without live keys: each provider's own wire format, including how it
 * reports cached and reasoning tokens, goes through the real provider package, and the recorded
 * cost is checked against a hand calculation from the provider's published prices.
 */

const catalogue = loadCatalogue();

async function finishUsage(kind: ProviderKind, model: string): Promise<TokenUsage> {
  const body = readFileSync(new URL(`./fixtures/providers/${kind}.sse`, import.meta.url), 'utf8');
  const fetchImpl: typeof fetch = async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const connection =
    kind === 'openai-compatible'
      ? { kind, baseURL: 'http://vllm.internal/v1', fetch: fetchImpl }
      : { kind, apiKey: 'k', fetch: fetchImpl };
  let finish: GatewayStreamEvent | undefined;
  for await (const event of streamModelCall(
    languageModel(connection, model),
    { messages: [{ role: 'user', content: 'hi' }] },
    new AbortController().signal,
  )) {
    if (event.type === 'finish') finish = event;
  }
  if (finish?.type !== 'finish') throw new Error('no finish event');
  return finish.usage;
}

function catalogued(id: string): PricedModel {
  const model = catalogue.models.get(id);
  if (model === undefined) throw new Error(`${id} is not in the catalogue`);
  return model;
}

const noEstimate = { inputTokens: 0, outputTokens: 0 };

describe('provider usage priced from the catalogue (M2 exit criterion 3)', () => {
  it('BG-8: Anthropic Claude Sonnet 4.5, with cache reads and writes', async () => {
    const priced = priceUsage(
      await finishUsage('anthropic', 'claude-sonnet-4-5'),
      catalogued('anthropic:claude-sonnet-4-5'),
      noEstimate,
    );
    // $3/M * 12 + $0.30/M * 2000 + $3.75/M * 100 + $15/M * 7 = $0.001116
    expect(priced).toMatchObject({
      uncachedInputTokens: 12,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
      outputTokens: 7,
      estimated: false,
    });
    expect(priced.costMicroUsd).toBe(1116n);
  });

  it('BG-8: OpenAI GPT-5 mini, where cached tokens are inside input_tokens and reasoning inside output', async () => {
    const priced = priceUsage(
      await finishUsage('openai', 'gpt-5-mini'),
      catalogued('openai:gpt-5-mini'),
      noEstimate,
    );
    // $0.25/M * 100 + $0.025/M * 2000 + $2/M * 40 = $0.000155
    expect(priced).toMatchObject({
      uncachedInputTokens: 100,
      cacheReadTokens: 2000,
      outputTokens: 40,
      reasoningTokens: 30,
    });
    expect(priced.costMicroUsd).toBe(155n);
  });

  it('BG-8: Google Gemini 2.5 Flash, where thinking tokens are billed as output', async () => {
    const priced = priceUsage(
      await finishUsage('google', 'gemini-2.5-flash'),
      catalogued('google:gemini-2.5-flash'),
      noEstimate,
    );
    // $0.30/M * 500 + $0.03/M * 1000 + $2.50/M * (20 + 50) = $0.000355
    expect(priced).toMatchObject({
      uncachedInputTokens: 500,
      cacheReadTokens: 1000,
      outputTokens: 70,
      reasoningTokens: 50,
    });
    expect(priced.costMicroUsd).toBe(355n);
  });

  it('BG-8: an OpenAI-compatible server priced by hand, with no cache price, rounded up', async () => {
    const custom: PricedModel = {
      prices: {
        inputMicroUsdPerMtok: 100_000,
        outputMicroUsdPerMtok: 300_000,
        cacheReadMicroUsdPerMtok: null,
        cacheWriteMicroUsdPerMtok: null,
      },
      tiers: [],
    };
    const priced = priceUsage(
      await finishUsage('openai-compatible', 'llama3.3'),
      custom,
      noEstimate,
    );
    // $0.10/M * (18 + 32 cached, billed as input) + $0.30/M * 8 = 7.4 micro-USD, rounded up to 8.
    expect(priced).toMatchObject({ uncachedInputTokens: 18, cacheReadTokens: 32, outputTokens: 8 });
    expect(priced.costMicroUsd).toBe(8n);
  });
});
