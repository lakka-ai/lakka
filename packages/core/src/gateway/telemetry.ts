import type { Attributes } from '@opentelemetry/api';
import type { ModelView, ProviderKind } from '@lakka/contracts';
import type { PricedUsage } from '../costs/pricing.ts';

/*
 * Span attribute names (OB-1, OB-2, ADR 0041). Model calls use the OpenTelemetry GenAI semantic
 * conventions, so traces read correctly in any backend a customer already runs. The names are
 * kept here rather than imported: the conventions are still experimental and have moved to
 * their own repository, and a test pins these to the published values. Our own attributes use
 * the lakka. prefix. No attribute ever carries prompt or response text (OB-4).
 */

export const GEN_AI = {
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  REQUEST_STREAM: 'gen_ai.request.stream',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  RESPONSE_TIME_TO_FIRST_CHUNK: 'gen_ai.response.time_to_first_chunk',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  USAGE_CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',
  USAGE_REASONING_OUTPUT_TOKENS: 'gen_ai.usage.reasoning.output_tokens',
} as const;

export const ERROR_TYPE = 'error.type';

export const LK = {
  REQUEST_ID: 'lakka.request_id',
  WORKSPACE_ID: 'lakka.workspace_id',
  SURFACE: 'lakka.surface',
  MODEL: 'lakka.model',
  ATTEMPT: 'lakka.attempt',
  ATTEMPTS: 'lakka.attempts',
  OUTCOME: 'lakka.outcome',
  COST_MICRO_USD: 'lakka.cost_micro_usd',
  USAGE_ESTIMATED: 'lakka.usage_estimated',
  HTTP_STATUS: 'lakka.provider.http_status',
  ROUTING_RULE: 'lakka.routing.rule',
  ROUTING_ROUTE_ID: 'lakka.routing.route_id',
  ROUTING_SIGNAL: 'lakka.routing.signal',
  ROUTING_CONFIDENCE: 'lakka.routing.confidence',
  ROUTING_DEFAULT_REASON: 'lakka.routing.default_reason',
  ROUTING_OVERRIDDEN: 'lakka.routing.overridden',
  BUDGET_CAPS: 'lakka.budget.caps',
  BUDGET_ESTIMATE_MICRO_USD: 'lakka.budget.estimate_micro_usd',
  BUDGET_SCOPE: 'lakka.budget.scope',
  BUDGET_FALLBACK_MODEL: 'lakka.budget.fallback_model',
  TOOL_NAME: 'lakka.tool.name',
  TOOL_STATUS: 'lakka.tool.status',
  TOOL_CREDENTIAL_PRINCIPAL: 'lakka.tool.credential_principal_id',
  PRINCIPAL_ID: 'lakka.principal_id',
  ACTING_USER_ID: 'lakka.acting_user_id',
  CONVERSATION_ID: 'lakka.conversation_id',
  BUDGET_RESERVED_MICRO_USD: 'lakka.budget.reserved_micro_usd',
  BUDGET_ACTUAL_MICRO_USD: 'lakka.budget.actual_micro_usd',
  BUDGET_DELTA_MICRO_USD: 'lakka.budget.delta_micro_usd',
  BUDGET_FROM_ATTEMPT: 'lakka.budget.from_attempt',
  // What the request list and trace say about a request (OB-1, ADR 0095). Ids, codes and
  // numbers only: never text a person wrote.
  /** What the caller asked for: 'auto', a model reference, or 'route/<name>'. */
  ROUTING_REQUESTED: 'lakka.routing.requested',
  /** The lowest confidence the closest route needed, for the direction of its model (RT-5). */
  ROUTING_THRESHOLD: 'lakka.routing.threshold',
  /** On a model call: the model a cap moved the request away from (BG-7). */
  BUDGET_FALLBACK_FROM: 'lakka.budget.fallback_from',
  /** What the cap that had no room had left, when a cap refused or moved a request. */
  BUDGET_REMAINING_MICRO_USD: 'lakka.budget.remaining_micro_usd',
  /** What the cheaper model a cap moved the request to could cost. */
  BUDGET_FALLBACK_ESTIMATE_MICRO_USD: 'lakka.budget.fallback_estimate_micro_usd',
  /** What was held against the caps. */
  BUDGET_HELD_MICRO_USD: 'lakka.budget.held_micro_usd',
  /** The provider that did not answer, when every attempt failed. */
  PROVIDER: 'lakka.provider',
  /** On a request that carried an approval: the request it continues. */
  CONTINUES_REQUEST_ID: 'lakka.continues_request_id',
  /** On a request the per-person rate limit refused: how long until it would pass (BG-12). */
  RATE_LIMIT_RETRY_AFTER_MS: 'lakka.rate_limit.retry_after_ms',
} as const;

/**
 * Every attribute name a stored span may carry (OB-4, ADR 0076). The exporter drops anything
 * else, so a library's span, or an attribute added in a hurry, cannot put content in the trace
 * store: a name must be added here, deliberately, before it is kept.
 */
export const STORED_ATTRIBUTES: ReadonlySet<string> = new Set<string>([
  ...Object.values(GEN_AI),
  ...Object.values(LK),
  ERROR_TYPE,
]);

/** The conventions' provider names; any other provider is named by its own name. */
export function providerName(kind: ProviderKind, name: string): string {
  switch (kind) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'gcp.gemini';
    case 'deepseek':
      return 'deepseek';
    // The conventions name no value for these, so they keep their own name.
    case 'moonshot':
    case 'qwencloud':
    case 'xiaomi-mimo':
    case 'zai':
    case 'openai-compatible':
      return name;
  }
}

export function requestAttributes(
  model: ModelView,
  kind: ProviderKind,
  maxTokens: number,
  temperature: number | undefined,
  attempt: number,
): Attributes {
  return {
    [GEN_AI.OPERATION_NAME]: 'chat',
    [GEN_AI.PROVIDER_NAME]: providerName(kind, model.provider),
    [GEN_AI.REQUEST_MODEL]: model.model,
    [GEN_AI.REQUEST_MAX_TOKENS]: maxTokens,
    [GEN_AI.REQUEST_STREAM]: true,
    ...(temperature === undefined ? {} : { [GEN_AI.REQUEST_TEMPERATURE]: temperature }),
    [LK.MODEL]: model.id,
    [LK.ATTEMPT]: attempt,
  };
}

/** The routing decision behind a model call, on its spans (AC 19). */
export function routingAttributes(routing: {
  rule: string;
  routeId: string | null;
  confidence: number | null;
  defaultReason: string | null;
  overriddenModel: string | null;
  budgetFallbackFrom: string | null;
}): Attributes {
  return {
    [LK.ROUTING_RULE]: routing.rule,
    [LK.ROUTING_OVERRIDDEN]: routing.overriddenModel !== null,
    ...(routing.routeId === null ? {} : { [LK.ROUTING_ROUTE_ID]: routing.routeId }),
    ...(routing.confidence === null ? {} : { [LK.ROUTING_CONFIDENCE]: routing.confidence }),
    ...(routing.defaultReason === null
      ? {}
      : { [LK.ROUTING_DEFAULT_REASON]: routing.defaultReason }),
    ...(routing.budgetFallbackFrom === null
      ? {}
      : { [LK.BUDGET_FALLBACK_FROM]: routing.budgetFallbackFrom }),
  };
}

export function usageAttributes(priced: PricedUsage): Attributes {
  return {
    // The conventions count cached tokens as part of input.
    [GEN_AI.USAGE_INPUT_TOKENS]: priced.inputTokens,
    [GEN_AI.USAGE_OUTPUT_TOKENS]: priced.outputTokens,
    [GEN_AI.USAGE_CACHE_READ_INPUT_TOKENS]: priced.cacheReadTokens,
    [GEN_AI.USAGE_CACHE_CREATION_INPUT_TOKENS]: priced.cacheWriteTokens,
    ...(priced.reasoningTokens === null
      ? {}
      : { [GEN_AI.USAGE_REASONING_OUTPUT_TOKENS]: priced.reasoningTokens }),
    // Attributes cannot hold a bigint; a cost past 2^53 micro-USD ($9 billion) is not a concern.
    [LK.COST_MICRO_USD]: Number(priced.costMicroUsd),
    [LK.USAGE_ESTIMATED]: priced.estimated,
  };
}
