import { MIN_CLASSIFY_WORDS, wordCount } from '@lakka/contracts';
import type { BudgetPeriod, BudgetScope, CentroidSource, RoutingSignal } from '@lakka/contracts';

/*
 * Scoring a message against a workspace's routes (tech spec, Classifier and routing; ADR 0043).
 * Pure functions over a frozen policy snapshot: embeddings are unit length, so similarity is a
 * dot product. Only vectors from the current embedding model count; a route whose centroid came
 * from another model scores nothing until it is recompiled.
 */

export type MatchMode = 'centroid' | 'nearest_example' | 'calibrated';

/** How requests are matched to routes. Chosen by the evaluation (ADR 0045). */
export const DEFAULT_MATCH_MODE: MatchMode = 'centroid';

export interface RouteSnapshot {
  id: string;
  name: string;
  model: string;
  fallbacks: readonly string[];
  allowCrossProvider: boolean;
  thresholdDown: number;
  thresholdUp: number;
  enabled: boolean;
  signals: readonly RoutingSignal[];
  /** What the route is scored from while it has no examples (RT-12, ADR 0122); may be empty. */
  description: string;
  exampleCount: number;
  centroid: { embedding: Float32Array; model: string; source: CentroidSource } | null;
  examples: readonly { embedding: Float32Array; model: string }[];
}

/** A cap that may apply to requests in the workspace (BG-1, ADR 0049). */
export interface BudgetSnapshot {
  id: string;
  scope: BudgetScope;
  /** The member's user principal, or the key's own principal; null for instance and workspace. */
  principalId: string | null;
  limitMicroUsd: bigint;
  period: BudgetPeriod;
}

export interface PolicySnapshot {
  workspaceId: string;
  version: number;
  routingEnabled: boolean;
  defaultModel: string | null;
  pinnedModel: string | null;
  routes: readonly RouteSnapshot[];
  /** The instance cap and every cap inside this workspace. */
  budgets: readonly BudgetSnapshot[];
  /** The allowlist: enabled tools the model can be offered, by name (TL-3, ADR 0069). */
  tools: readonly ToolSnapshot[];
  /** Whether prompts and replies are recorded, and for how long (OB-4, ADR 0077). */
  capture: Readonly<{ enabled: boolean; retentionDays: number }>;
}

/** An enabled tool, with the definition stored when it was synced (ADR 0069). */
export interface ToolSnapshot {
  id: string;
  serverId: string;
  serverName: string;
  /** Its name on its server. */
  name: string;
  /** What the model calls it: <server>__<tool> (H1). */
  modelName: string;
  title: string | null;
  description: string | null;
  inputSchema: Readonly<Record<string, unknown>>;
  annotations: Readonly<Record<string, boolean | null>>;
  approvalRequired: boolean;
}

export interface RouteScore {
  routeId: string;
  name: string;
  similarity: number;
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/** Unit-length mean of the vectors (tech spec, Compiling the policy). */
export function centroidOf(vectors: readonly (readonly number[])[]): number[] {
  const [first] = vectors;
  if (first === undefined) return [];
  const sum = Array.from({ length: first.length }, () => 0);
  for (const v of vectors)
    for (let i = 0; i < sum.length; i += 1) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
  const norm = Math.hypot(...sum);
  return norm === 0 ? sum : sum.map((x) => x / norm);
}

/**
 * What a route's centroid should be made from: its examples, with its description as one more
 * when it has one (ADR 0125); the description alone while it has no examples (ADR 0122). Null for
 * a route with neither, which the classifier never chooses. RT-12.
 */
export function scoringBasis(route: {
  exampleCount: number;
  description: string;
}): CentroidSource | null {
  const described = route.description.trim() !== '';
  if (route.exampleCount > 0) return described ? 'examples_and_description' : 'examples';
  return described ? 'description' : null;
}

/**
 * Whether a route needs compiling before its centroid is right for `model`: it has something to
 * score from, and its centroid is missing, from another model (ADR 0043), or made from something
 * else, such as a centroid compiled before ADR 0125 for a route with a description.
 */
export function centroidStale(
  route: Pick<RouteSnapshot, 'exampleCount' | 'description' | 'centroid'>,
  model: string,
): boolean {
  const basis = scoringBasis(route);
  return basis !== null && (route.centroid?.model !== model || route.centroid.source !== basis);
}

/**
 * What a route's description is embedded as (ADR 0122): its name, then the description, the
 * rendering the evaluation measured. Alone while the route has no examples, one of them after
 * (ADR 0125).
 */
export function describedRouteText(name: string, description: string): string {
  return `${name}: ${description.trim()}`;
}

/** Enabled routes that can be scored with `model`, best first. */
export function scoreRoutes(
  snapshot: PolicySnapshot,
  query: Float32Array,
  model: string,
  mode: MatchMode,
): RouteScore[] {
  const scores: RouteScore[] = [];
  for (const route of snapshot.routes) {
    if (!route.enabled) continue;
    let similarity: number | undefined;
    if (mode === 'centroid') {
      if (route.centroid?.model === model) similarity = dot(route.centroid.embedding, query);
    } else if (mode === 'calibrated') {
      if (route.centroid?.model === model) {
        // Relative to how tightly the route's own examples sit around its centroid: a route with
        // varied examples (code in many languages) scores lower in absolute terms even for
        // messages that clearly belong to it, so one shared threshold would starve it.
        const cohesion = cohesionOf(route, model);
        if (cohesion !== undefined) similarity = dot(route.centroid.embedding, query) / cohesion;
      }
    } else {
      for (const example of route.examples) {
        if (example.model !== model) continue;
        const s = dot(example.embedding, query);
        if (similarity === undefined || s > similarity) similarity = s;
      }
    }
    if (similarity !== undefined && Number.isFinite(similarity)) {
      scores.push({ routeId: route.id, name: route.name, similarity });
    }
  }
  return scores.toSorted((a, b) => b.similarity - a.similarity);
}

/** Mean similarity of a route's examples to its centroid, or undefined without both. */
export function cohesionOf(route: RouteSnapshot, model: string): number | undefined {
  if (route.centroid?.model !== model) return undefined;
  const centroid = route.centroid.embedding;
  const sims = route.examples
    .filter((e) => e.model === model)
    .map((e) => dot(e.embedding, centroid));
  if (sims.length === 0) return undefined;
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  return mean > 0 ? mean : undefined;
}

/** Whether a message is long enough to classify (MIN_CLASSIFY_WORDS). */
export function worthClassifying(text: string): boolean {
  return wordCount(text) >= MIN_CLASSIFY_WORDS;
}
