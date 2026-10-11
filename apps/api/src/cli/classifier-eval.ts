import { parseArgs } from 'node:util';
import { DEFAULT_THRESHOLD_DOWN, DEFAULT_THRESHOLD_UP } from '@lakka/contracts';
import {
  aggregate,
  BLEND_CASES,
  blendHolds,
  confusion,
  DEFAULT_DECISION_MARGIN,
  DEFAULT_MATCH_MODE,
  describedRoutes,
  directionsOf,
  fallbackHolds,
  loadDescriptionSets,
  loadEvaluationSet,
  loadOnnxEmbedder,
  loadProcessConfig,
  measure,
  measureFallback,
  prepareFallbackRotation,
  prepareSplits,
  thresholdGrid,
} from '@lakka/core';
import type { EvaluationParams, FallbackResult, MatchMode, PreparedSplit } from '@lakka/core';

/*
 * The routing evaluation (AC 11, ADR 0045), run against the bundled embedding model with no
 * network. By default it measures the defaults requests use (match mode, thresholds, margin)
 * over many random splits and fails below --min-accuracy: the regression gate for any change
 * to routing logic or the model. With --tune it searches thresholds on half the seeds and
 * reports the best setting on the other half, to choose new defaults.
 *
 *   lakka classifier-eval [--seeds 20] [--examples 12] [--min-accuracy 0.8] [--tune] [--confusion]
 *                            [--mode centroid|nearest_example] [--down 0.3] [--up 0.15] [--margin 0]
 *                            [--set <file>] [--examples-from <file>]
 *                            [--fallback] [--descriptions <file>]
 *
 * --set evaluates another set, such as a translation (packages/core/eval/routing-v1.de.json).
 * --examples-from takes each route's examples from a parallel set instead, message for message:
 * routes written in English, people writing in another language (NF-A3).
 *
 * --fallback adds ADR 0122's scenario (RT-12): each route in turn has only its description, the
 * others their examples, for every description set in --descriptions (by default
 * packages/core/eval/routing-v1.descriptions.json), at the thresholds measured above. It fails if,
 * for any set, the fallback gives lower accuracy or more misroutes than no fallback. It then
 * compares examples alone with examples and the description (ADR 0125): the new route with 1, 2,
 * 4 and 12 of its own examples, and every route described at 12. It fails if the description
 * does worse in any case but the new route at 12, which is reported only.
 *
 * Every message is a fixed string from the committed evaluation set, not user content.
 */

const { values: args } = parseArgs({
  options: {
    seeds: { type: 'string', default: '20' },
    // Twelve examples per route is the gate's setting and the count admins are advised to give.
    examples: { type: 'string', default: '12' },
    'min-accuracy': { type: 'string' },
    tune: { type: 'boolean', default: false },
    confusion: { type: 'boolean', default: false },
    // Explore a setting other than the defaults; the gate always measures what it is given.
    mode: { type: 'string' },
    down: { type: 'string' },
    up: { type: 'string' },
    margin: { type: 'string' },
    set: { type: 'string' },
    'examples-from': { type: 'string' },
    fallback: { type: 'boolean', default: false },
    descriptions: { type: 'string' },
  },
});

const config = loadProcessConfig(process.env);
const set = loadEvaluationSet(args.set);
const exampleSet =
  args['examples-from'] === undefined ? undefined : loadEvaluationSet(args['examples-from']);
const directions = directionsOf(set);
const seedCount = Number(args.seeds);
const examplesPerRoute = Number(args.examples);
const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);

const embedder = await loadOnnxEmbedder({
  modelDir: config.classifier.modelDir,
  threads: config.classifier.threads,
});
const texts = [
  ...new Set([
    ...set.routes.flatMap((r) => r.messages),
    ...set.unsure,
    ...(exampleSet?.routes.flatMap((r) => r.messages) ?? []),
  ]),
];
const embeddings = new Map<string, Float32Array>();
const times: number[] = [];
for (const text of texts) {
  const started = performance.now();
  embeddings.set(text, await embedder.embed(text));
  times.push(performance.now() - started);
}
const sorted = times.toSorted((a, b) => a - b);
const pct = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const roundDeep = (value: unknown): unknown =>
  typeof value === 'number'
    ? round(value)
    : Array.isArray(value)
      ? value.map(roundDeep)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)]))
        : value;

const evaluate = (splits: PreparedSplit[], params: EvaluationParams) =>
  aggregate(splits.map((s) => measure(s, params, directions)));

const prepared = new Map<MatchMode, PreparedSplit[]>();
for (const mode of ['centroid', 'nearest_example', 'calibrated'] as const) {
  prepared.set(
    mode,
    prepareSplits(set, embeddings, {
      mode,
      examplesPerRoute,
      seeds,
      ...(exampleSet === undefined ? {} : { examplesFrom: { set: exampleSet, embeddings } }),
    }),
  );
}

const defaults: EvaluationParams = {
  mode:
    args.mode === 'nearest_example'
      ? 'nearest_example'
      : args.mode === 'centroid'
        ? 'centroid'
        : DEFAULT_MATCH_MODE,
  thresholdDown: args.down === undefined ? DEFAULT_THRESHOLD_DOWN : Number(args.down),
  thresholdUp: args.up === undefined ? DEFAULT_THRESHOLD_UP : Number(args.up),
  margin: args.margin === undefined ? DEFAULT_DECISION_MARGIN : Number(args.margin),
};

const report: Record<string, unknown> = {
  set: {
    file: args.set ?? 'routing-v1.json',
    ...(args['examples-from'] === undefined ? {} : { examples_from: args['examples-from'] }),
    version: set.version,
    routes: set.routes.length,
    clear: set.routes.reduce((n, r) => n + r.messages.length, 0),
    unsure: set.unsure.length,
  },
  model: embedder.modelId,
  seeds: seedCount,
  examples_per_route: examplesPerRoute,
  embed_ms: { p50: round(pct(0.5)), p95: round(pct(0.95)) },
  defaults: {
    params: defaults,
    result: roundDeep(evaluate(prepared.get(defaults.mode) ?? [], defaults)),
  },
};

if (args.confusion) {
  report['confusion'] = roundDeep(
    confusion(prepared.get(defaults.mode) ?? [], defaults, directions),
  );
}

if (args.tune) {
  // Tune on the first half of the seeds, report on the second half, so the reported figures
  // are not the ones the search optimized.
  const half = Math.floor(seedCount / 2);
  const tuning: Record<string, unknown> = {};
  for (const mode of ['centroid', 'nearest_example', 'calibrated'] as const) {
    const splits = prepared.get(mode) ?? [];
    const tuneOn = splits.slice(0, half);
    const reportOn = splits.slice(half);
    let best: { params: EvaluationParams; accuracy: number; misroute: number } | undefined;
    for (const point of thresholdGrid()) {
      const params = { mode, ...point };
      const result = evaluate(tuneOn, params);
      const better =
        best === undefined ||
        result.accuracy.mean > best.accuracy + 1e-9 ||
        (Math.abs(result.accuracy.mean - best.accuracy) <= 1e-9 &&
          result.misrouteRate.mean < best.misroute);
      if (better)
        best = { params, accuracy: result.accuracy.mean, misroute: result.misrouteRate.mean };
    }
    if (best !== undefined) {
      tuning[mode] = {
        chosen: best.params,
        tuned_accuracy: round(best.accuracy),
        held_out: roundDeep(evaluate(reportOn, best.params)),
        spec_defaults_held_out: roundDeep(
          evaluate(reportOn, { mode, thresholdDown: 0.75, thresholdUp: 0.55, margin: 0 }),
        ),
      };
    }
  }
  report['tuning'] = tuning;
}

let fallbackOk = true;
let blendOk = true;
if (args.fallback) {
  const sets = loadDescriptionSets(args.descriptions);
  const examplesFrom =
    exampleSet === undefined ? {} : { examplesFrom: { set: exampleSet, embeddings } };
  const summary = (result: FallbackResult) =>
    roundDeep({
      today: { accuracy: result.today.accuracy, misrouteRate: result.today.misrouteRate },
      fallback: {
        accuracy: result.fallback.accuracy,
        misrouteRate: result.fallback.misrouteRate,
        clearAccuracy: result.fallback.clearAccuracy,
        unsureCorrectRate: result.fallback.unsureCorrectRate,
      },
      newRouteRecall: result.newRouteRecall,
    });
  const bySet: Record<string, unknown> = {};
  const blendBySet: Record<string, unknown> = {};
  const withExamples = new Map<number, FallbackResult>();
  const rotation = (
    descriptions: ReadonlyMap<string, Float32Array>,
    extra: { newRouteExamples?: number; blend?: 'new' | 'all' } = {},
  ) =>
    measureFallback(
      prepareFallbackRotation(set, embeddings, {
        examplesPerRoute,
        seeds,
        descriptions,
        ...examplesFrom,
        ...extra,
      }),
      defaults,
      directions,
    );
  const row = (result: FallbackResult) =>
    roundDeep({
      accuracy: result.fallback.accuracy,
      misrouteRate: result.fallback.misrouteRate,
      newRouteRecall: result.newRouteRecall.fallback,
    });
  for (const descriptionSet of sets.sets) {
    const descriptions = new Map<string, Float32Array>();
    for (const [route, text] of describedRoutes(descriptionSet, set)) {
      descriptions.set(route, await embedder.embed(text));
    }
    const result = rotation(descriptions);
    const holds = fallbackHolds(result);
    fallbackOk &&= holds;
    bySet[descriptionSet.name] = { ok: holds, ...(summary(result) as object) };
    const cases: Record<string, unknown> = {};
    for (const blendCase of BLEND_CASES) {
      const { newRouteExamples } = blendCase;
      let examples = withExamples.get(newRouteExamples);
      if (examples === undefined) {
        examples = rotation(new Map(), { newRouteExamples });
        withExamples.set(newRouteExamples, examples);
      }
      const blended = rotation(descriptions, { newRouteExamples, blend: blendCase.blend });
      const ok = blendHolds(examples, blended);
      if (blendCase.gated) blendOk &&= ok;
      cases[blendCase.name] = {
        gated: blendCase.gated,
        ok,
        examples: row(examples),
        with_description: row(blended),
      };
    }
    blendBySet[descriptionSet.name] = cases;
  }
  report['fallback'] = {
    descriptions: {
      file: args.descriptions ?? 'routing-v1.descriptions.json',
      version: sets.version,
    },
    params: defaults,
    sets: bySet,
    blend: blendBySet,
    ok: fallbackOk,
    blend_ok: blendOk,
  };
}

const accuracy = (report['defaults'] as { result: { accuracy: { mean: number } } }).result.accuracy
  .mean;
const minimum = args['min-accuracy'] === undefined ? undefined : Number(args['min-accuracy']);
const ok = minimum === undefined || accuracy >= minimum;
report['gate'] =
  minimum === undefined ? null : { ok, min_accuracy: minimum, accuracy: round(accuracy) };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(ok && fallbackOk && blendOk ? 0 : 1);
