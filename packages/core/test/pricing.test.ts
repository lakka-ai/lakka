import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@lakka/contracts';
import { applicablePrices, costOf, priceUsage } from '../src/costs/pricing.ts';
import type { PricedModel } from '../src/costs/pricing.ts';

const sonnet: PricedModel = {
  prices: {
    inputMicroUsdPerMtok: 3_000_000,
    outputMicroUsdPerMtok: 15_000_000,
    cacheReadMicroUsdPerMtok: 300_000,
    cacheWriteMicroUsdPerMtok: 3_750_000,
  },
  tiers: [
    {
      aboveInputTokens: 200_000,
      prices: {
        inputMicroUsdPerMtok: 6_000_000,
        outputMicroUsdPerMtok: 22_500_000,
        cacheReadMicroUsdPerMtok: 600_000,
        cacheWriteMicroUsdPerMtok: 7_500_000,
      },
    },
  ],
};

const usage = (u: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: null,
  uncachedInputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  ...u,
});

const noEstimate = { inputTokens: 0, outputTokens: 0 };

describe('cost accounting (ADR 0039)', () => {
  it('prices uncached input, cache reads, cache writes and output each at their own rate', () => {
    const priced = priceUsage(
      usage({
        inputTokens: 2112,
        uncachedInputTokens: 12,
        cacheReadTokens: 2000,
        cacheWriteTokens: 100,
        outputTokens: 7,
      }),
      sonnet,
      noEstimate,
    );
    // 12 * 3 + 2000 * 0.3 + 100 * 3.75 + 7 * 15 = 1116 micro-USD, i.e. $0.001116.
    expect(priced.costMicroUsd).toBe(1116n);
    expect(priced).toMatchObject({
      inputTokens: 2112,
      estimated: false,
      tierAboveInputTokens: null,
    });
  });

  it('rounds up once per call, never down: one token of a cheap model costs one micro-USD', () => {
    const nano: PricedModel = {
      prices: {
        inputMicroUsdPerMtok: 50_000,
        outputMicroUsdPerMtok: 400_000,
        cacheReadMicroUsdPerMtok: null,
        cacheWriteMicroUsdPerMtok: null,
      },
      tiers: [],
    };
    expect(
      priceUsage(usage({ inputTokens: 1, outputTokens: 0 }), nano, noEstimate).costMicroUsd,
    ).toBe(1n);
    expect(
      priceUsage(usage({ inputTokens: 0, outputTokens: 0 }), nano, noEstimate).costMicroUsd,
    ).toBe(0n);
    // 20 tokens * 0.05 = exactly 1: no extra micro-USD from rounding.
    expect(
      priceUsage(usage({ inputTokens: 20, outputTokens: 0 }), nano, noEstimate).costMicroUsd,
    ).toBe(1n);
  });

  it('applies the long-context tier to the whole call once input exceeds its threshold', () => {
    expect(applicablePrices(sonnet, 200_000).tierAboveInputTokens).toBeNull();
    const long = priceUsage(
      usage({ inputTokens: 250_000, uncachedInputTokens: 250_000, outputTokens: 1000 }),
      sonnet,
      noEstimate,
    );
    expect(long.tierAboveInputTokens).toBe(200_000);
    // 250000 * 6 + 1000 * 22.5 = 1,522,500 micro-USD.
    expect(long.costMicroUsd).toBe(1_522_500n);
    // Cached input counts towards the threshold too.
    const cached = priceUsage(
      usage({
        inputTokens: 210_000,
        uncachedInputTokens: 10_000,
        cacheReadTokens: 200_000,
        outputTokens: 0,
      }),
      sonnet,
      noEstimate,
    );
    expect(cached.tierAboveInputTokens).toBe(200_000);
  });

  it('bills cache tokens at the input price when the model has no cache price', () => {
    const noCache: PricedModel = {
      prices: {
        inputMicroUsdPerMtok: 1_000_000,
        outputMicroUsdPerMtok: 2_000_000,
        cacheReadMicroUsdPerMtok: null,
        cacheWriteMicroUsdPerMtok: null,
      },
      tiers: [],
    };
    const priced = priceUsage(
      usage({
        inputTokens: 100,
        uncachedInputTokens: 50,
        cacheReadTokens: 30,
        cacheWriteTokens: 20,
        outputTokens: 0,
      }),
      noCache,
      noEstimate,
    );
    expect(priced.prices).toMatchObject({
      cacheReadMicroUsdPerMtok: 1_000_000,
      cacheWriteMicroUsdPerMtok: 1_000_000,
    });
    expect(priced.costMicroUsd).toBe(100n);
  });

  it('bills input the provider counted but did not split as uncached, and the larger reading when they disagree', () => {
    expect(
      priceUsage(usage({ inputTokens: 1000, outputTokens: 0 }), sonnet, noEstimate)
        .uncachedInputTokens,
    ).toBe(1000);
    const disagree = priceUsage(
      usage({ inputTokens: 1000, uncachedInputTokens: 100, cacheReadTokens: 500, outputTokens: 0 }),
      sonnet,
      noEstimate,
    );
    expect(disagree.uncachedInputTokens).toBe(500);
    expect(disagree.inputTokens).toBe(1000);
  });

  it('BG-4: with no usage reported, bills the pessimistic estimate and marks the record', () => {
    const priced = priceUsage(null, sonnet, { inputTokens: 5000, outputTokens: 200 });
    expect(priced).toMatchObject({ estimated: true, uncachedInputTokens: 5000, outputTokens: 200 });
    expect(priced.costMicroUsd).toBe(18_000n);
    const partial = priceUsage(usage({ inputTokens: 5000 }), sonnet, {
      inputTokens: 9999,
      outputTokens: 300,
    });
    expect(partial).toMatchObject({
      estimated: true,
      uncachedInputTokens: 5000,
      outputTokens: 300,
    });
  });

  it('stays exact beyond the range of a double', () => {
    const tokens = {
      uncachedInputTokens: 10_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10_000_000,
    };
    const prices = {
      inputMicroUsdPerMtok: 9_999_999_999,
      outputMicroUsdPerMtok: 9_999_999_997,
      cacheReadMicroUsdPerMtok: 0,
      cacheWriteMicroUsdPerMtok: 0,
    };
    expect(costOf(tokens, prices)).toBe(199_999_999_960n);
  });
});
