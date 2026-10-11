import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { decideRoute } from './decide.ts';
import type { Direction } from './decide.ts';
import { centroidOf, describedRouteText, scoreRoutes, worthClassifying } from './score.ts';
import type { MatchMode, PolicySnapshot, RouteScore, RouteSnapshot } from './score.ts';

/*
 * The routing evaluation (AC 11, ADR 0045): the regression suite for every change to routing
 * logic, thresholds or the embedding model. Each route's labelled messages are split at random
 * into examples, which build the policy, and held-out tests; this repeats over many seeds, so a
 * result is reported as a mean with its spread rather than one lucky split (CLAUDE.md,
 * Testing). The decision is made by decideRoute, the same function requests use.
 */

export const EVALUATION_SET_PATH = fileURLToPath(
  new URL('../../eval/routing-v1.json', import.meta.url),
);

export const evaluationSet = z
  .object({
    version: z.int().positive(),
    description: z.string(),
    routes: z
      .array(
        z
          .object({
            name: z.string().min(1),
            direction: z.enum(['down', 'up']),
            messages: z.array(z.string().min(1)).min(10),
          })
          .strict(),
      )
      .min(2),
    unsure: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type EvaluationSet = z.infer<typeof evaluationSet>;

export function loadEvaluationSet(path: string = EVALUATION_SET_PATH): EvaluationSet {
  return evaluationSet.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

/**
 * Route descriptions for the evaluation set's routes (ADR 0122), in several sets written by
 * different hands, so a result does not rest on one wording. English only: an admin writes them
 * once, and messages arrive in any language.
 */
export const DESCRIPTION_SETS_PATH = fileURLToPath(
  new URL('../../eval/routing-v1.descriptions.json', import.meta.url),
);

export const descriptionSets = z
  .object({
    version: z.int().positive(),
    description: z.string(),
    sets: z
      .array(
        z
          .object({
            name: z.string().min(1),
            provenance: z.string().min(1),
            // The route API's limit on a description.
            routes: z.record(z.string().min(1), z.string().trim().min(1).max(500)),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type DescriptionSets = z.infer<typeof descriptionSets>;
export type DescriptionSet = DescriptionSets['sets'][number];

export function loadDescriptionSets(path: string = DESCRIPTION_SETS_PATH): DescriptionSets {
  return descriptionSets.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

/** One description set's text for each route of `set`, as compiling a policy embeds it. */
export function describedRoutes(
  descriptions: DescriptionSet,
  set: EvaluationSet,
): Map<string, string> {
  const names = new Set(set.routes.map((r) => r.name));
  for (const name of Object.keys(descriptions.routes)) {
    if (!names.has(name))
      throw new Error(`description set ${descriptions.name} names no route ${name}`);
  }
  return new Map(
    set.routes.map((route) => {
      const description = descriptions.routes[route.name];
      if (description === undefined) {
        throw new Error(`description set ${descriptions.name} has no route ${route.name}`);
      }
      return [route.name, describedRouteText(route.name, description)];
    }),
  );
}

/** A small, fast, seedable PRNG, so every split can be reproduced from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface EvaluationParams {
  mode: MatchMode;
  thresholdDown: number;
  thresholdUp: number;
  margin: number;
}

interface TestCase {
  text: string;
  /** The intended route, or null where "not sure" is the right answer. */
  label: string | null;
  /** Scores against the split's routes; null for a message too short to classify. */
  scores: RouteScore[] | null;
}

export interface PreparedSplit {
  seed: number;
  tests: TestCase[];
}

const MODEL = 'evaluation';

/** A message's vector, which every message of a set must have. */
function vectorLookup(from: ReadonlyMap<string, Float32Array>) {
  return (text: string): Float32Array => {
    const v = from.get(text);
    if (v === undefined) throw new Error('a message has no embedding');
    return v;
  };
}

/**
 * Take each route's examples from a parallel set instead, message for message, such as the
 * English set while testing its translation: routes written in one language, people writing in
 * another (NF-A3). The split is the same; only the examples' text differs.
 */
type ExamplesFrom = { set: EvaluationSet; embeddings: ReadonlyMap<string, Float32Array> };

/** Where each route's examples and held-out tests sit in its message list, for one seed. */
function splitPositions(
  set: EvaluationSet,
  examplesPerRoute: number,
  seed: number,
): Map<string, { examples: number[]; tests: number[] }> {
  const random = mulberry32(seed);
  const positions = new Map<string, { examples: number[]; tests: number[] }>();
  for (const route of set.routes) {
    // Positions, not texts, so a parallel set splits the same way; the shuffle does not look at
    // the values, so this is the same split as shuffling the messages themselves.
    const order = shuffled(
      route.messages.map((_, i) => i),
      random,
    );
    positions.set(route.name, {
      examples: order.slice(0, examplesPerRoute),
      tests: order.slice(examplesPerRoute),
    });
  }
  return positions;
}

/** Each route's example vectors for a split, from the set itself or from a parallel one. */
function exampleVectors(
  set: EvaluationSet,
  embeddings: ReadonlyMap<string, Float32Array>,
  positions: ReturnType<typeof splitPositions>,
  examplesFrom: ExamplesFrom | undefined,
): Map<string, Float32Array[]> {
  const vector = vectorLookup(examplesFrom?.embeddings ?? embeddings);
  const out = new Map<string, Float32Array[]>();
  for (const route of set.routes) {
    let sources: readonly string[] = route.messages;
    if (examplesFrom !== undefined) {
      const parallel = examplesFrom.set.routes.find((r) => r.name === route.name);
      if (parallel === undefined || parallel.messages.length !== route.messages.length) {
        throw new Error(`the example set has no parallel route ${route.name}`);
      }
      sources = parallel.messages;
    }
    const at = positions.get(route.name)?.examples ?? [];
    out.set(
      route.name,
      at.map((i) => vector(sources[i] ?? '')),
    );
  }
  return out;
}

/** A route as the evaluation's policy holds it: a centroid of its examples, or the one given. */
function evaluationRoute(
  name: string,
  examples: readonly Float32Array[],
  centroid?: Float32Array,
): RouteSnapshot {
  const embedding =
    centroid ??
    (examples.length === 0
      ? undefined
      : Float32Array.from(centroidOf(examples.map((e) => Array.from(e)))));
  return {
    id: name,
    name,
    model: `${name}:model`,
    fallbacks: [],
    allowCrossProvider: false,
    thresholdDown: 1,
    thresholdUp: 1,
    enabled: true,
    signals: [],
    description: '',
    exampleCount: examples.length,
    centroid:
      embedding === undefined
        ? null
        : { embedding, model: MODEL, source: centroid === undefined ? 'examples' : 'description' },
    examples: examples.map((e) => ({ embedding: e, model: MODEL })),
  };
}

/** Every held-out message of a split, then every "unsure" one, scored against `routes`. */
function scoredSplit(
  set: EvaluationSet,
  positions: ReturnType<typeof splitPositions>,
  routes: readonly RouteSnapshot[],
  vector: (text: string) => Float32Array,
  mode: MatchMode,
  seed: number,
): PreparedSplit {
  const tests: TestCase[] = [];
  for (const route of set.routes) {
    for (const i of positions.get(route.name)?.tests ?? [])
      tests.push({ text: route.messages[i] ?? '', label: route.name, scores: null });
  }
  for (const text of set.unsure) tests.push({ text, label: null, scores: null });
  const snapshot: PolicySnapshot = {
    workspaceId: 'evaluation',
    version: seed,
    routingEnabled: true,
    defaultModel: null,
    pinnedModel: null,
    routes,
    capture: { enabled: false, retentionDays: 7 },
    budgets: [],
    tools: [],
  };
  for (const test of tests) {
    test.scores = worthClassifying(test.text)
      ? scoreRoutes(snapshot, vector(test.text), MODEL, mode)
      : null;
  }
  return { seed, tests };
}

/**
 * Splits the set for each seed and scores every held-out message once. Scores do not depend on
 * thresholds, so a threshold search reuses them.
 */
export function prepareSplits(
  set: EvaluationSet,
  embeddings: ReadonlyMap<string, Float32Array>,
  options: {
    mode: MatchMode;
    examplesPerRoute: number;
    seeds: readonly number[];
    examplesFrom?: ExamplesFrom;
  },
): PreparedSplit[] {
  const vector = vectorLookup(embeddings);
  return options.seeds.map((seed) => {
    const positions = splitPositions(set, options.examplesPerRoute, seed);
    const examples = exampleVectors(set, embeddings, positions, options.examplesFrom);
    const routes = set.routes.map((r) => evaluationRoute(r.name, examples.get(r.name) ?? []));
    return scoredSplit(set, positions, routes, vector, options.mode, seed);
  });
}

/** One seed with one route described and the others trained: without it, and with it. */
export interface FallbackSplit {
  seed: number;
  /** The route that has only its description. */
  route: string;
  /** The product without the fallback: a route with no examples is never chosen. */
  today: PreparedSplit;
  /** With the fallback: the route scored against its description (ADR 0122). */
  fallback: PreparedSplit;
}

/**
 * ADR 0122's scenario, for every seed and every route in turn: that route has only its
 * description, the others their examples, split exactly as `prepareSplits` splits them. The
 * described route's held-out messages stay in the tests, so they count against both sides.
 * `newRouteExamples` gives the route that many of its own examples instead of its description.
 * `blend` adds descriptions to examples with the weight of one example (ADR 0125): `new` to that
 * route's, `all` to every route's.
 */
export function prepareFallbackRotation(
  set: EvaluationSet,
  embeddings: ReadonlyMap<string, Float32Array>,
  options: {
    examplesPerRoute: number;
    seeds: readonly number[];
    /** Each route's description, embedded as compiling a policy would (describedRouteText). */
    descriptions: ReadonlyMap<string, Float32Array>;
    examplesFrom?: ExamplesFrom;
    newRouteExamples?: number;
    blend?: 'new' | 'all';
  },
): FallbackSplit[] {
  if (options.blend !== undefined && options.newRouteExamples === undefined)
    throw new Error('blending needs newRouteExamples');
  const description = (route: string) => {
    const vector = options.descriptions.get(route);
    if (vector === undefined) throw new Error(`no description for route ${route}`);
    return vector;
  };
  const vector = vectorLookup(embeddings);
  const mode: MatchMode = 'centroid';
  const out: FallbackSplit[] = [];
  for (const seed of options.seeds) {
    const positions = splitPositions(set, options.examplesPerRoute, seed);
    const examples = exampleVectors(set, embeddings, positions, options.examplesFrom);
    for (const described of set.routes) {
      const others = set.routes
        .filter((r) => r.name !== described.name)
        .map((r) => {
          const own = examples.get(r.name) ?? [];
          return evaluationRoute(
            r.name,
            options.blend === 'all' ? [description(r.name), ...own] : own,
          );
        });
      let route: RouteSnapshot;
      if (options.newRouteExamples === undefined) {
        route = evaluationRoute(described.name, [], description(described.name));
      } else {
        const own = (examples.get(described.name) ?? []).slice(0, options.newRouteExamples);
        route = evaluationRoute(
          described.name,
          options.blend === undefined ? own : [description(described.name), ...own],
        );
      }
      out.push({
        seed,
        route: described.name,
        today: scoredSplit(set, positions, others, vector, mode, seed),
        fallback: scoredSplit(set, positions, [...others, route], vector, mode, seed),
      });
    }
  }
  return out;
}

export interface SplitMetrics {
  seed: number;
  /** AC 11: right route for clearly typed messages, "not sure" for the rest, over all messages. */
  accuracy: number;
  /** Clearly typed messages that went to their route or to "not sure", never to a wrong route. */
  noMisrouteRate: number;
  /** Clearly typed messages that went to their route. */
  clearAccuracy: number;
  /** Messages sent to a route they do not belong to: the costly mistake. */
  misrouteRate: number;
  /** Clearly typed messages the classifier declined. */
  clearNotSureRate: number;
  /** "Not sure" messages correctly left to the default. */
  unsureCorrectRate: number;
  perRoute: Record<string, number>;
}

export function measure(
  split: PreparedSplit,
  params: EvaluationParams,
  directions: ReadonlyMap<string, Direction>,
): SplitMetrics {
  let clear = 0;
  let clearCorrect = 0;
  let clearNotSure = 0;
  let misrouted = 0;
  let unsure = 0;
  let unsureCorrect = 0;
  const perRouteTotals = new Map<string, { total: number; correct: number }>();
  for (const test of split.tests) {
    const decision =
      test.scores === null
        ? null
        : decideRoute(
            test.scores,
            (id) => {
              const direction = directions.get(id);
              return direction === undefined
                ? undefined
                : {
                    thresholdDown: params.thresholdDown,
                    thresholdUp: params.thresholdUp,
                    direction,
                  };
            },
            params.margin,
          ).routeId;
    if (test.label === null) {
      unsure += 1;
      if (decision === null) unsureCorrect += 1;
      else misrouted += 1;
      continue;
    }
    clear += 1;
    const totals = perRouteTotals.get(test.label) ?? { total: 0, correct: 0 };
    totals.total += 1;
    if (decision === test.label) {
      clearCorrect += 1;
      totals.correct += 1;
    } else if (decision === null) {
      clearNotSure += 1;
    } else {
      misrouted += 1;
    }
    perRouteTotals.set(test.label, totals);
  }
  const all = clear + unsure;
  return {
    seed: split.seed,
    accuracy: (clearCorrect + unsureCorrect) / all,
    noMisrouteRate: (clearCorrect + clearNotSure) / clear,
    clearAccuracy: clearCorrect / clear,
    misrouteRate: misrouted / all,
    clearNotSureRate: clearNotSure / clear,
    unsureCorrectRate: unsureCorrect / unsure,
    perRoute: Object.fromEntries(
      [...perRouteTotals].map(([route, t]) => [route, t.correct / t.total]),
    ),
  };
}

export interface Spread {
  mean: number;
  std: number;
  min: number;
  max: number;
}

export function spread(values: readonly number[]): Spread {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.length > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1) : 0;
  return { mean, std: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) };
}

export interface Aggregate {
  accuracy: Spread;
  noMisrouteRate: Spread;
  clearAccuracy: Spread;
  misrouteRate: Spread;
  clearNotSureRate: Spread;
  unsureCorrectRate: Spread;
  perRoute: Record<string, Spread>;
}

export function aggregate(metrics: readonly SplitMetrics[]): Aggregate {
  const of = (pick: (m: SplitMetrics) => number) => spread(metrics.map(pick));
  const routes = Object.keys(metrics[0]?.perRoute ?? {});
  return {
    accuracy: of((m) => m.accuracy),
    noMisrouteRate: of((m) => m.noMisrouteRate),
    clearAccuracy: of((m) => m.clearAccuracy),
    misrouteRate: of((m) => m.misrouteRate),
    clearNotSureRate: of((m) => m.clearNotSureRate),
    unsureCorrectRate: of((m) => m.unsureCorrectRate),
    perRoute: Object.fromEntries(routes.map((r) => [r, of((m) => m.perRoute[r] ?? 0)])),
  };
}

function meanOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** The mean of several splits' metrics, such as one seed's rotations. */
function meanMetrics(metrics: readonly SplitMetrics[]): SplitMetrics {
  const avg = (pick: (m: SplitMetrics) => number) =>
    metrics.reduce((a, m) => a + pick(m), 0) / metrics.length;
  const routes = Object.keys(metrics[0]?.perRoute ?? {});
  return {
    seed: metrics[0]?.seed ?? 0,
    accuracy: avg((m) => m.accuracy),
    noMisrouteRate: avg((m) => m.noMisrouteRate),
    clearAccuracy: avg((m) => m.clearAccuracy),
    misrouteRate: avg((m) => m.misrouteRate),
    clearNotSureRate: avg((m) => m.clearNotSureRate),
    unsureCorrectRate: avg((m) => m.unsureCorrectRate),
    perRoute: Object.fromEntries(routes.map((r) => [r, avg((m) => m.perRoute[r] ?? 0)])),
  };
}

export interface FallbackResult {
  today: Aggregate;
  fallback: Aggregate;
  /** How much of the described route's own held-out messages reached it. */
  newRouteRecall: { today: Spread; fallback: Spread };
}

/**
 * ADR 0122's scenario measured: each seed's rotations are averaged, then reported as a mean with
 * its spread over seeds, as `aggregate` reports plain splits.
 */
export function measureFallback(
  splits: readonly FallbackSplit[],
  params: EvaluationParams,
  directions: ReadonlyMap<string, Direction>,
): FallbackResult {
  const bySeed = new Map<
    number,
    { today: SplitMetrics[]; fallback: SplitMetrics[]; recallToday: number[]; recall: number[] }
  >();
  for (const split of splits) {
    const entry = bySeed.get(split.seed) ?? {
      today: [],
      fallback: [],
      recallToday: [],
      recall: [],
    };
    const today = measure(split.today, params, directions);
    const fallback = measure(split.fallback, params, directions);
    entry.today.push(today);
    entry.fallback.push(fallback);
    entry.recallToday.push(today.perRoute[split.route] ?? 0);
    entry.recall.push(fallback.perRoute[split.route] ?? 0);
    bySeed.set(split.seed, entry);
  }
  const seeds = [...bySeed.values()];
  return {
    today: aggregate(seeds.map((s) => meanMetrics(s.today))),
    fallback: aggregate(seeds.map((s) => meanMetrics(s.fallback))),
    newRouteRecall: {
      today: spread(seeds.map((s) => meanOf(s.recallToday))),
      fallback: spread(seeds.map((s) => meanOf(s.recall))),
    },
  };
}

/** ADR 0122's CI rule: with the fallback, no lower accuracy and no more misroutes than without. */
export function fallbackHolds(result: FallbackResult): boolean {
  return (
    result.fallback.accuracy.mean >= result.today.accuracy.mean &&
    result.fallback.misrouteRate.mean <= result.today.misrouteRate.mean
  );
}

/**
 * ADR 0125's comparisons: a new route with some of its own examples, with and without its
 * description, and every route described at the full count. A case not gated is reported only:
 * the new route at twelve passes by hundredths of a point, which numerics alone could flip.
 */
export const BLEND_CASES = [
  { name: 'new_1', newRouteExamples: 1, blend: 'new', gated: true },
  { name: 'new_2', newRouteExamples: 2, blend: 'new', gated: true },
  { name: 'new_4', newRouteExamples: 4, blend: 'new', gated: true },
  { name: 'new_12', newRouteExamples: 12, blend: 'new', gated: false },
  { name: 'all_12', newRouteExamples: 12, blend: 'all', gated: true },
] as const;

/**
 * ADR 0125's CI rule: with the description among the examples, no lower accuracy and no more
 * misroutes than the same examples alone.
 */
export function blendHolds(examples: FallbackResult, blended: FallbackResult): boolean {
  return (
    blended.fallback.accuracy.mean >= examples.fallback.accuracy.mean &&
    blended.fallback.misrouteRate.mean <= examples.fallback.misrouteRate.mean
  );
}

export function directionsOf(set: EvaluationSet): Map<string, Direction> {
  return new Map(set.routes.map((r) => [r.name, r.direction]));
}

function steps(from: number, to: number): number[] {
  return Array.from(
    { length: Math.round((to - from) / 0.05) + 1 },
    (_, i) => Math.round((from + i * 0.05) * 100) / 100,
  );
}

/** Every threshold pair the search tries, with the cheaper direction never below the other (RT-5). */
export function thresholdGrid(): { thresholdDown: number; thresholdUp: number; margin: number }[] {
  const grid: { thresholdDown: number; thresholdUp: number; margin: number }[] = [];
  for (const thresholdDown of steps(0.1, 1.2)) {
    for (const thresholdUp of steps(0.1, thresholdDown)) {
      for (const margin of [0, 0.02, 0.05]) grid.push({ thresholdDown, thresholdUp, margin });
    }
  }
  return grid;
}

/**
 * Where each route's held-out messages went, as shares of that route's tests: the route itself,
 * another route, or "none" (not sure). "unsure" is the set of messages with no right route.
 */
export function confusion(
  splits: readonly PreparedSplit[],
  params: EvaluationParams,
  directions: ReadonlyMap<string, Direction>,
): Record<string, Record<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const split of splits) {
    for (const test of split.tests) {
      const decision =
        test.scores === null
          ? null
          : decideRoute(
              test.scores,
              (id) => {
                const direction = directions.get(id);
                return direction === undefined
                  ? undefined
                  : {
                      thresholdDown: params.thresholdDown,
                      thresholdUp: params.thresholdUp,
                      direction,
                    };
              },
              params.margin,
            ).routeId;
      const row = counts.get(test.label ?? 'unsure') ?? new Map<string, number>();
      row.set(decision ?? 'none', (row.get(decision ?? 'none') ?? 0) + 1);
      counts.set(test.label ?? 'unsure', row);
    }
  }
  return Object.fromEntries(
    [...counts].map(([label, row]) => {
      const total = [...row.values()].reduce((a, b) => a + b, 0);
      return [
        label,
        Object.fromEntries(
          [...row].toSorted((a, b) => b[1] - a[1]).map(([to, n]) => [to, n / total]),
        ),
      ];
    }),
  );
}
