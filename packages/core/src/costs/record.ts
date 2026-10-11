import type {
  DefaultReason,
  Principal,
  ResolutionRule,
  Surface,
  UsageOutcome,
} from '@lakka/contracts';
import { insertUsage } from '@lakka/db';
import type { Db, UsageRow } from '@lakka/db';
import type { PricedUsage } from './pricing.ts';

/*
 * Writes one usage record (BG-8, ADR 0039): who spent how much, where, on which model, at which
 * prices. Attribution follows the request's principal and, through it, the person whose budget
 * applies (invariant 2).
 */

/** The routing decision behind a request, recorded on each of its usage rows (RT-8, RT-9). */
export interface UsageRouting {
  rule: ResolutionRule;
  /** The route that chose the model, or for an override the route that lost. */
  routeId: string | null;
  confidence: number | null;
  defaultReason: DefaultReason | null;
  /** Set when the user overrode a routed conversation: the model it had been routed to. */
  overriddenModel: string | null;
  /** Set when a cap forced a cheaper model (BG-7): the model chosen first. */
  budgetFallbackFrom: string | null;
}

export interface UsageRecord {
  requestId: string;
  attempt: number;
  outcome: UsageOutcome;
  surface: Surface;
  workspaceId: string;
  principal: Principal;
  /** Model reference and its provider part (ADR 0037). */
  model: string;
  provider: string;
  providerConfigId: string | null;
  priced: PricedUsage;
  finishReason: string | null;
  latencyMs: number;
  ttftMs: number | null;
  routing: UsageRouting;
}

export async function recordUsage(ctx: { db: Db }, record: UsageRecord): Promise<UsageRow> {
  const { priced } = record;
  return insertUsage(ctx.db, {
    requestId: record.requestId,
    attempt: record.attempt,
    outcome: record.outcome,
    surface: record.surface,
    workspaceId: record.workspaceId,
    principalId: record.principal.id,
    actingUserId: record.principal.actingUserId,
    model: record.model,
    provider: record.provider,
    providerConfigId: record.providerConfigId,
    inputTokens: priced.inputTokens,
    uncachedInputTokens: priced.uncachedInputTokens,
    cacheReadTokens: priced.cacheReadTokens,
    cacheWriteTokens: priced.cacheWriteTokens,
    outputTokens: priced.outputTokens,
    reasoningTokens: priced.reasoningTokens,
    usageEstimated: priced.estimated,
    inputMicroUsdPerMtok: priced.prices.inputMicroUsdPerMtok,
    outputMicroUsdPerMtok: priced.prices.outputMicroUsdPerMtok,
    cacheReadMicroUsdPerMtok: priced.prices.cacheReadMicroUsdPerMtok,
    cacheWriteMicroUsdPerMtok: priced.prices.cacheWriteMicroUsdPerMtok,
    priceTierAboveInputTokens: priced.tierAboveInputTokens,
    costMicroUsd: priced.costMicroUsd,
    finishReason: record.finishReason,
    latencyMs: Math.max(0, Math.round(record.latencyMs)),
    ttftMs: record.ttftMs === null ? null : Math.max(0, Math.round(record.ttftMs)),
    resolutionRule: record.routing.rule,
    routeId: record.routing.routeId,
    routeConfidence: record.routing.confidence,
    defaultReason: record.routing.defaultReason,
    wasOverridden: record.routing.overriddenModel !== null,
    overriddenModel: record.routing.overriddenModel,
    budgetFallbackFrom: record.routing.budgetFallbackFrom,
  });
}
