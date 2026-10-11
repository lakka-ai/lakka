import { describe, expect, it } from 'vitest';
import { ConfigError, FIRST_PARTY_KINDS, parseModelRef } from '@lakka/contracts';
import { loadCatalogue, parseCatalogue } from '../src/models/catalogue.ts';

const catalogue = loadCatalogue();
const models = [...catalogue.models.values()];

const valid = {
  serial: 1,
  source: 'https://example.com/prices.json',
  sourceCommit: 'a'.repeat(40),
  license: 'MIT',
  generatedAt: '2026-09-25',
  models: [
    {
      id: 'openai:gpt-test',
      provider: 'openai',
      model: 'gpt-test',
      contextWindow: 1000,
      maxOutputTokens: 100,
      capabilities: {
        vision: false,
        pdf: false,
        tools: true,
        structuredOutput: true,
        promptCaching: false,
        reasoning: false,
      },
      prices: {
        inputMicroUsdPerMtok: 1_000_000,
        outputMicroUsdPerMtok: 2_000_000,
        cacheReadMicroUsdPerMtok: null,
        cacheWriteMicroUsdPerMtok: null,
      },
      tiers: [],
    },
  ],
};

const p = (input: number, output: number) => ({
  inputMicroUsdPerMtok: input,
  outputMicroUsdPerMtok: output,
  cacheReadMicroUsdPerMtok: null,
  cacheWriteMicroUsdPerMtok: null,
});

describe('bundled model catalogue (ADR 0037)', () => {
  it('PR-5: ships models for every first-party provider, offline', () => {
    const providers = new Set(models.map((m) => m.provider));
    expect([...providers].toSorted()).toEqual([...FIRST_PARTY_KINDS].toSorted());
    expect(catalogue.source.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('BG-4: every catalogue model has a real input and output price and real limits', () => {
    for (const m of models) {
      expect({
        id: m.id,
        priced: m.prices.inputMicroUsdPerMtok > 0 && m.prices.outputMicroUsdPerMtok > 0,
      }).toEqual({ id: m.id, priced: true });
      expect(m.maxOutputTokens).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
    }
  });

  it('long-context tiers only ever raise prices, in increasing order', () => {
    for (const m of models) {
      let floor = 0;
      for (const tier of m.tiers) {
        expect(tier.aboveInputTokens).toBeGreaterThan(floor);
        floor = tier.aboveInputTokens;
        expect(tier.prices.inputMicroUsdPerMtok).toBeGreaterThanOrEqual(
          m.prices.inputMicroUsdPerMtok,
        );
        expect(tier.prices.outputMicroUsdPerMtok).toBeGreaterThanOrEqual(
          m.prices.outputMicroUsdPerMtok,
        );
      }
    }
  });

  it('keeps known prices exact: Gemini 2.5 Pro and its long-context tier', () => {
    const pro = catalogue.models.get('google:gemini-2.5-pro');
    expect(pro?.prices).toEqual({
      inputMicroUsdPerMtok: 1_250_000,
      outputMicroUsdPerMtok: 10_000_000,
      cacheReadMicroUsdPerMtok: 125_000,
      cacheWriteMicroUsdPerMtok: null,
    });
    expect(pro?.tiers).toEqual([
      {
        aboveInputTokens: 200_000,
        prices: {
          inputMicroUsdPerMtok: 2_500_000,
          outputMicroUsdPerMtok: 15_000_000,
          cacheReadMicroUsdPerMtok: 250_000,
          cacheWriteMicroUsdPerMtok: null,
        },
      },
    ]);
  });

  it('PR-5: Claude Sonnet 4.5 has a 200k context and no long-context tier', () => {
    // Anthropic retired its 1M-context beta, so a longer request is refused, not billed higher.
    const sonnet = catalogue.models.get('anthropic:claude-sonnet-4-5');
    expect(sonnet?.contextWindow).toBe(200_000);
    expect(sonnet?.tiers).toEqual([]);
    expect(sonnet?.prices).toEqual({
      inputMicroUsdPerMtok: 3_000_000,
      outputMicroUsdPerMtok: 15_000_000,
      cacheReadMicroUsdPerMtok: 300_000,
      cacheWriteMicroUsdPerMtok: 3_750_000,
    });
  });

  it('PR-5: prices Qwen input brackets as long-context tiers, with their own cache prices', () => {
    const coder = catalogue.models.get('qwencloud:qwen3-coder-plus');
    expect(coder?.prices).toEqual({
      inputMicroUsdPerMtok: 1_000_000,
      outputMicroUsdPerMtok: 5_000_000,
      cacheReadMicroUsdPerMtok: 100_000,
      cacheWriteMicroUsdPerMtok: null,
    });
    expect(coder?.tiers.map((t) => [t.aboveInputTokens, t.prices])).toEqual([
      [32_000, { ...p(1_800_000, 9_000_000), cacheReadMicroUsdPerMtok: 180_000 }],
      [128_000, { ...p(3_000_000, 15_000_000), cacheReadMicroUsdPerMtok: 300_000 }],
      [256_000, { ...p(6_000_000, 60_000_000), cacheReadMicroUsdPerMtok: 600_000 }],
    ]);
  });

  it('BG-4: leaves out Qwen models that bill reasoning above other output', () => {
    // Usage counts reasoning as output, so these would be undercharged.
    for (const id of ['qwen-turbo', 'qwen-plus-latest', 'qwen-plus-2025-07-14']) {
      expect(catalogue.models.has(`qwencloud:${id}`)).toBe(false);
    }
    expect(catalogue.models.has('qwencloud:qwen-turbo-2024-11-01')).toBe(true);
  });

  it('BG-4: no cache price is zero; an unknown one is null and billed as input', () => {
    for (const m of models) {
      for (const prices of [m.prices, ...m.tiers.map((t) => t.prices)]) {
        expect([
          m.id,
          prices.cacheReadMicroUsdPerMtok,
          prices.cacheWriteMicroUsdPerMtok,
        ]).not.toContain(0);
      }
    }
    expect(catalogue.models.get('deepseek:deepseek-v4-pro')?.prices).toEqual({
      inputMicroUsdPerMtok: 1_320_000,
      outputMicroUsdPerMtok: 3_960_000,
      cacheReadMicroUsdPerMtok: 44_000,
      cacheWriteMicroUsdPerMtok: null,
    });
  });

  it('refuses a catalogue with fractional prices, a mismatched id or a duplicate', () => {
    expect(() => parseCatalogue(valid)).not.toThrow();
    const [model] = valid.models;
    const broken = (patch: object) => ({ ...valid, models: [{ ...model, ...patch }] });
    expect(() =>
      parseCatalogue(broken({ prices: { ...model?.prices, inputMicroUsdPerMtok: 2.5 } })),
    ).toThrow(ConfigError);
    expect(() => parseCatalogue(broken({ id: 'openai:other' }))).toThrow(ConfigError);
    expect(() => parseCatalogue({ ...valid, models: [model, model] })).toThrow(/twice/);
  });
});

describe('model references', () => {
  it('splits at the first colon, so provider model ids may contain colons', () => {
    expect(parseModelRef('anthropic:claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(parseModelRef('ollama:llama3.3:70b')).toEqual({
      provider: 'ollama',
      model: 'llama3.3:70b',
    });
  });

  it('rejects references without a provider, with spaces, or with an empty model', () => {
    for (const bad of ['claude', ':model', 'Open AI:gpt', 'openai:', 'openai:gpt 5', 'openai::x']) {
      expect(parseModelRef(bad)).toBeUndefined();
    }
  });
});
