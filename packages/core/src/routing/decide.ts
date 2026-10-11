import type { RouteScore } from './score.ts';

/*
 * Whether the classifier's best match is confident enough to route on (RT-5, RT-6, ADR 0045).
 * Mistakes cost differently in each direction: sending hard work to a cheaper model gives a
 * confidently wrong answer, sending easy work to a pricier one only wastes money. So a route
 * whose model is cheaper than the workspace default ("down") needs the higher threshold.
 *
 * Only the best match is considered. If it does not clear its own threshold, or is too close to
 * the runner-up to tell apart, the answer is "not sure" and the request goes to the default.
 * Falling through to the second-best route would route on a weaker match than the one rejected.
 */

export type Direction = 'down' | 'up';

export interface RouteThresholds {
  thresholdDown: number;
  thresholdUp: number;
  direction: Direction;
}

export type ClassifierDecision =
  | { routeId: string; similarity: number; threshold: number }
  | {
      routeId: null;
      reason: 'no_routes' | 'below_threshold' | 'ambiguous';
      similarity: number | null;
    };

/** How far the best match must lead the runner-up. Tuned by the evaluation (ADR 0045). */
export const DEFAULT_DECISION_MARGIN = 0;

export function decideRoute(
  scores: readonly RouteScore[],
  thresholdsOf: (routeId: string) => RouteThresholds | undefined,
  margin: number = DEFAULT_DECISION_MARGIN,
): ClassifierDecision {
  const [best, second] = scores;
  if (best === undefined) return { routeId: null, reason: 'no_routes', similarity: null };
  const thresholds = thresholdsOf(best.routeId);
  if (thresholds === undefined)
    return { routeId: null, reason: 'no_routes', similarity: best.similarity };
  const threshold =
    thresholds.direction === 'down' ? thresholds.thresholdDown : thresholds.thresholdUp;
  if (best.similarity < threshold) {
    return { routeId: null, reason: 'below_threshold', similarity: best.similarity };
  }
  if (second !== undefined && best.similarity - second.similarity < margin) {
    return { routeId: null, reason: 'ambiguous', similarity: best.similarity };
  }
  return { routeId: best.routeId, similarity: best.similarity, threshold };
}
