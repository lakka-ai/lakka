import type { GatewayRequest, ModelView } from '@lakka/contracts';
import { applicablePrices } from '../costs/pricing.ts';
import { estimateInputTokens } from '../gateway/estimate.ts';

/*
 * The cost to reserve before sending (BG-2, invariant 4, ADR 0050): prompt tokens at the input
 * price plus the maximum possible output at the output price, so a long answer can never take
 * spend past a cap. Every choice errs high:
 *   - prompt tokens use the upper reading (two bytes per token), which also picks the
 *     long-context tier whenever the real count might reach it;
 *   - each prompt token is priced at the dearer of input and cache write, since a provider may
 *     write the whole prompt to its cache at a premium;
 *   - output is what dispatch will ask for: the request's maximum, or the model's own (F2).
 */

const MILLION = 1_000_000n;

/** Upper bound on one attempt's cost on `model`, in micro-USD, rounded up. */
export function estimateAttemptCost(request: GatewayRequest, model: ModelView): bigint {
  const inputTokens = estimateInputTokens(request, 'upper');
  const { prices } = applicablePrices(model, inputTokens);
  const inputPrice = Math.max(prices.inputMicroUsdPerMtok, prices.cacheWriteMicroUsdPerMtok);
  const outputTokens = request.maxOutputTokens ?? model.maxOutputTokens;
  const total =
    BigInt(inputTokens) * BigInt(inputPrice) +
    BigInt(outputTokens) * BigInt(prices.outputMicroUsdPerMtok);
  return (total + MILLION - 1n) / MILLION;
}

/** Upper bound across the candidates a request may fail over to (F3). */
export function estimateRequestCost(
  request: GatewayRequest,
  candidates: readonly ModelView[],
): bigint {
  if (candidates.length === 0) throw new Error('no candidate model to estimate');
  return candidates
    .map((m) => estimateAttemptCost(request, m))
    .reduce((max, cost) => (cost > max ? cost : max));
}
