import type { ModelPrices, PriceTier, TokenUsage } from '@lakka/contracts';

/*
 * What a model call cost (tech spec, Cost accounting; ADR 0039). Exact integer arithmetic in
 * micro-USD: every token count is multiplied by its price in micro-USD per million tokens, the
 * products are summed, and the total is divided by a million once, rounding up. BigInt, because
 * ten million tokens at a large price overflows a double's exact range.
 *
 * Wherever the provider's report is incomplete, the choice that bills more wins, because a
 * budget that undercounts can be exceeded (invariant 3):
 *   - a missing cache price bills those tokens at the input price
 *   - input the provider counted but did not split is billed as uncached input
 *   - a count the provider did not report at all comes from the caller's pessimistic estimate,
 *     and the record says so
 */

export interface PricedModel {
  prices: ModelPrices;
  tiers: readonly PriceTier[];
}

/** Prices with every cache price filled in, as charged. */
export interface AppliedPrices {
  inputMicroUsdPerMtok: number;
  outputMicroUsdPerMtok: number;
  cacheReadMicroUsdPerMtok: number;
  cacheWriteMicroUsdPerMtok: number;
}

export interface PricedUsage {
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  /** True when some count came from the estimate instead of the provider. */
  estimated: boolean;
  prices: AppliedPrices;
  /** The long-context tier that applied, by its threshold, or null. */
  tierAboveInputTokens: number | null;
  costMicroUsd: bigint;
}

/** Pessimistic counts to use where the provider reported nothing. */
export interface UsageEstimate {
  inputTokens: number;
  outputTokens: number;
}

const MILLION = 1_000_000n;

/** The tier with the highest threshold the input exceeds, or the base prices. */
export function applicablePrices(
  model: PricedModel,
  inputTokens: number,
): { prices: AppliedPrices; tierAboveInputTokens: number | null } {
  let chosen: { prices: ModelPrices; above: number | null } = { prices: model.prices, above: null };
  for (const tier of model.tiers) {
    if (
      inputTokens > tier.aboveInputTokens &&
      (chosen.above === null || tier.aboveInputTokens > chosen.above)
    ) {
      chosen = { prices: tier.prices, above: tier.aboveInputTokens };
    }
  }
  const p = chosen.prices;
  return {
    prices: {
      inputMicroUsdPerMtok: p.inputMicroUsdPerMtok,
      outputMicroUsdPerMtok: p.outputMicroUsdPerMtok,
      cacheReadMicroUsdPerMtok: p.cacheReadMicroUsdPerMtok ?? p.inputMicroUsdPerMtok,
      cacheWriteMicroUsdPerMtok: p.cacheWriteMicroUsdPerMtok ?? p.inputMicroUsdPerMtok,
    },
    tierAboveInputTokens: chosen.above,
  };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function costOf(
  tokens: Pick<
    PricedUsage,
    'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens'
  >,
  prices: AppliedPrices,
): bigint {
  const total =
    BigInt(tokens.uncachedInputTokens) * BigInt(prices.inputMicroUsdPerMtok) +
    BigInt(tokens.cacheReadTokens) * BigInt(prices.cacheReadMicroUsdPerMtok) +
    BigInt(tokens.cacheWriteTokens) * BigInt(prices.cacheWriteMicroUsdPerMtok) +
    BigInt(tokens.outputTokens) * BigInt(prices.outputMicroUsdPerMtok);
  return ceilDiv(total, MILLION);
}

const count = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : Math.max(0, Math.ceil(value));

/**
 * Prices a call from what the provider reported (null when it reported nothing, for example
 * because the stream was cut off), falling back to `estimate` for anything missing.
 */
export function priceUsage(
  usage: TokenUsage | null,
  model: PricedModel,
  estimate: UsageEstimate,
): PricedUsage {
  let estimated = false;
  const cacheReadTokens = count(usage?.cacheReadTokens) ?? 0;
  const cacheWriteTokens = count(usage?.cacheWriteTokens) ?? 0;
  const reportedTotal = count(usage?.inputTokens);
  const reportedUncached = count(usage?.uncachedInputTokens);

  let uncachedInputTokens: number;
  if (reportedTotal === null && reportedUncached === null) {
    uncachedInputTokens = Math.max(
      0,
      Math.ceil(estimate.inputTokens) - cacheReadTokens - cacheWriteTokens,
    );
    estimated = true;
  } else {
    // If the total and the parts disagree, bill the larger reading.
    const fromTotal =
      reportedTotal === null ? 0 : Math.max(0, reportedTotal - cacheReadTokens - cacheWriteTokens);
    uncachedInputTokens = Math.max(reportedUncached ?? 0, fromTotal);
  }

  let outputTokens = count(usage?.outputTokens);
  if (outputTokens === null) {
    outputTokens = Math.max(0, Math.ceil(estimate.outputTokens));
    estimated = true;
  }

  const inputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const { prices, tierAboveInputTokens } = applicablePrices(model, inputTokens);
  const tokens = { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens };
  return {
    inputTokens,
    ...tokens,
    reasoningTokens: count(usage?.reasoningTokens),
    estimated,
    prices,
    tierAboveInputTokens,
    costMicroUsd: costOf(tokens, prices),
  };
}
