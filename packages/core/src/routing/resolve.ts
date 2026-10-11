import { blendedPrice, NoModelError, UnknownModelError } from '@lakka/contracts';
import type { DefaultReason, ModelPrices, ResolutionRule, RoutingSignal } from '@lakka/contracts';
import { decideRoute, DEFAULT_DECISION_MARGIN } from './decide.ts';
import type { Direction } from './decide.ts';
import { worthClassifying } from './score.ts';
import type { PolicySnapshot, RouteScore, RouteSnapshot } from './score.ts';
import { detectSignals } from './signals.ts';

/*
 * Choosing the model for a request (RT-3, RT-5, RT-6, RT-11; tech spec, The resolution order;
 * ADR 0046). A fixed order, cheapest check first, first match wins:
 *
 *   1. explicit     the user chose a model
 *   2. sticky       the conversation was already routed (RT-7)
 *   3. pinned       the workspace pins a model
 *   4. signal       a deterministic signal claimed by a route
 *   5. classified   the classifier's best route, above the threshold for its direction
 *   6. default      the workspace default
 *
 * With routing off (RT-11) only 1, 3 and 6 apply. The classifier is passed in and called only
 * when steps 1 to 4 did not decide, so most requests never load or run the model. Everything
 * else is a plain function of its inputs, so the whole order is unit-tested without a database.
 */

export interface StickyDecision {
  /** The model the conversation was routed to. */
  model: string;
  /** The route that chose it, or null for a "not sure" that went to the default. */
  routeId: string | null;
}

export interface ResolutionInput {
  policy: PolicySnapshot;
  /** A model the user picked for this request, or null to let the workspace decide. */
  explicitModel: string | null;
  /**
   * A route the caller asked for by name (API-4, G1): its model and fallbacks, as the caller's
   * own choice. Refused with UnknownModelError if the workspace has no such enabled route.
   */
  explicitRoute?: string | null;
  /** The conversation's stored decision, or null if it has none yet. */
  sticky: StickyDecision | null;
  /** The text routing looks at: the latest user message (E8). */
  text: string;
  /**
   * Scores the text against the policy's routes, best first; undefined if the classifier is
   * unavailable (invariant 10). Called at most once.
   */
  classify: (text: string) => Promise<readonly RouteScore[] | undefined>;
  /** Prices, to tell whether a route's model is cheaper than the default (E4). */
  priceOf: (model: string) => Promise<ModelPrices | undefined>;
  margin?: number;
}

export interface Resolution {
  rule: ResolutionRule;
  model: string;
  /** Tried in order if the model fails before its first chunk (E13). */
  fallbacks: readonly string[];
  allowCrossProvider: boolean;
  routeId: string | null;
  signal: RoutingSignal | null;
  /**
   * The classifier's best similarity when it ran (rule 'classified', or 'default' after a
   * "not sure"); null when no classification took place (RT-8).
   */
  confidence: number | null;
  /** For rule 'default': why nothing earlier decided. */
  reason: DefaultReason | null;
  /**
   * The lowest confidence the closest route needed, for the direction of its model (RT-5), when
   * the classifier ran and scored a route; null otherwise. What a trace compares against.
   */
  threshold: number | null;
  /**
   * Whether the conversation keeps this decision for its later messages (RT-7). True when a
   * signal or the classifier decided, including a considered "not sure"; false when the
   * decision is made fresh on every request anyway, or when nothing could be judged yet.
   */
  remember: boolean;
}

export async function resolveRequestModel(input: ResolutionInput): Promise<Resolution> {
  const { policy } = input;
  const base = {
    fallbacks: [],
    allowCrossProvider: false,
    routeId: null,
    signal: null,
    confidence: null,
    reason: null,
    threshold: null,
    remember: false,
  } satisfies Omit<Resolution, 'rule' | 'model'>;

  if (input.explicitRoute !== undefined && input.explicitRoute !== null) {
    const route = policy.routes.find((r) => r.enabled && r.name === input.explicitRoute);
    if (route === undefined) throw new UnknownModelError('no enabled route with that name');
    return {
      ...base,
      rule: 'explicit',
      model: route.model,
      routeId: route.id,
      ...failoverOf(route, route.model),
    };
  }

  if (input.explicitModel !== null) {
    return { ...base, rule: 'explicit', model: input.explicitModel };
  }

  if (policy.routingEnabled && input.sticky !== null) {
    const route =
      input.sticky.routeId === null ? undefined : routeById(policy, input.sticky.routeId);
    return {
      ...base,
      rule: 'sticky',
      model: input.sticky.model,
      routeId: input.sticky.routeId,
      // The route's current fallbacks, if it still exists; the model itself stays as decided,
      // since switching mid-conversation throws away the provider's prompt cache.
      ...(route === undefined ? {} : failoverOf(route, input.sticky.model)),
    };
  }

  if (policy.pinnedModel !== null) {
    return { ...base, rule: 'pinned', model: policy.pinnedModel };
  }

  const toDefault = (
    reason: DefaultReason,
    extra: { confidence?: number | null; threshold?: number | null; remember?: boolean } = {},
  ): Resolution => {
    if (policy.defaultModel === null) {
      throw new NoModelError('no model was chosen and the workspace has no default model');
    }
    return { ...base, ...extra, rule: 'default', model: policy.defaultModel, reason };
  };

  if (!policy.routingEnabled) return toDefault('routing_off');

  const enabled = policy.routes.filter((r) => r.enabled);
  for (const signal of detectSignals(input.text)) {
    // A signal is claimed by at most one route in a workspace (ADR 0042).
    const route = enabled.find((r) => r.signals.includes(signal));
    if (route !== undefined) {
      return {
        ...base,
        rule: 'signal',
        model: route.model,
        routeId: route.id,
        signal,
        remember: true,
        ...failoverOf(route, route.model),
      };
    }
  }

  if (!enabled.some((r) => r.centroid !== null)) return toDefault('no_routes');
  if (!worthClassifying(input.text)) return toDefault('too_short');
  const scores = await input.classify(input.text);
  if (scores === undefined) return toDefault('classifier_unavailable');
  const best = scores[0];
  const bestRoute = best === undefined ? undefined : routeById(policy, best.routeId);
  if (best === undefined || bestRoute === undefined) return toDefault('no_routes');

  const direction = await directionOf(bestRoute.model, policy.defaultModel, input.priceOf);
  const decision = decideRoute(
    scores,
    (id) =>
      id === bestRoute.id
        ? { thresholdDown: bestRoute.thresholdDown, thresholdUp: bestRoute.thresholdUp, direction }
        : undefined,
    input.margin ?? DEFAULT_DECISION_MARGIN,
  );
  const threshold = direction === 'down' ? bestRoute.thresholdDown : bestRoute.thresholdUp;
  if (decision.routeId === null) {
    return toDefault(decision.reason, {
      confidence: decision.similarity,
      threshold,
      remember: true,
    });
  }
  return {
    ...base,
    rule: 'classified',
    model: bestRoute.model,
    routeId: bestRoute.id,
    confidence: decision.similarity,
    threshold,
    remember: true,
    ...failoverOf(bestRoute, bestRoute.model),
  };
}

function routeById(policy: PolicySnapshot, id: string): RouteSnapshot | undefined {
  return policy.routes.find((r) => r.id === id);
}

function failoverOf(
  route: RouteSnapshot,
  model: string,
): Pick<Resolution, 'fallbacks' | 'allowCrossProvider'> {
  return {
    fallbacks: route.fallbacks.filter((f) => f !== model),
    allowCrossProvider: route.allowCrossProvider,
  };
}

/**
 * Whether routing to `model` moves the request down (cheaper than the default) or up (the same
 * or pricier) (RT-5). When the comparison cannot be made, because there is no default or a price
 * is missing, the route is treated as cheaper and so needs the higher threshold: the mistake
 * that costs quality is the one to guard against.
 */
export async function directionOf(
  model: string,
  defaultModel: string | null,
  priceOf: (model: string) => Promise<ModelPrices | undefined>,
): Promise<Direction> {
  if (defaultModel === null) return 'down';
  if (model === defaultModel) return 'up';
  const [target, fallback] = await Promise.all([priceOf(model), priceOf(defaultModel)]);
  if (target === undefined || fallback === undefined) return 'down';
  return blendedPrice(target) < blendedPrice(fallback) ? 'down' : 'up';
}
