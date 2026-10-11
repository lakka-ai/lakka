import { describe, expect, it } from 'vitest';
import {
  aggregate,
  BLEND_CASES,
  blendHolds,
  confusion,
  describedRoutes,
  EVALUATION_SET_PATH,
  fallbackHolds,
  loadDescriptionSets,
  loadEvaluationSet,
  measure,
  measureFallback,
  mulberry32,
  prepareFallbackRotation,
  prepareSplits,
  spread,
  thresholdGrid,
} from '../src/routing/evaluation.ts';
import type { EvaluationSet } from '../src/routing/evaluation.ts';
import { cohesionOf, describedRouteText } from '../src/routing/score.ts';

/*
 * The evaluation machinery, on a tiny synthetic set whose embeddings are chosen by hand, so the
 * expected metrics can be worked out exactly. The real run uses the bundled model (ADR 0045).
 */

const unit = (...v: number[]) => {
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
};

const words = (prefix: string) =>
  Array.from({ length: 10 }, (_, i) => `${prefix} message number ${i}`);
const set: EvaluationSet = {
  version: 1,
  description: 'synthetic',
  routes: [
    { name: 'alpha', direction: 'up', messages: words('alpha') },
    { name: 'beta', direction: 'down', messages: words('beta') },
  ],
  unsure: ['what is the weather like today', 'tell me something'],
};
const embeddings = new Map<string, Float32Array>([
  ...words('alpha').map((t, i) => [t, unit(1, 0.05 * i, 0)] as const),
  ...words('beta').map((t, i) => [t, unit(0.05 * i, 1, 0)] as const),
  ['what is the weather like today', unit(0.1, 0.1, 1)],
  ['tell me something', unit(0, 0, 1)],
]);
const directions = new Map([
  ['alpha', 'up' as const],
  ['beta', 'down' as const],
]);

describe('routing evaluation (AC 11, ADR 0045)', () => {
  it('ships a valid, versioned evaluation set with enough messages per route', () => {
    const real = loadEvaluationSet();
    expect(real.version).toBe(1);
    expect(real.routes.length).toBeGreaterThanOrEqual(5);
    for (const route of real.routes) expect(route.messages.length).toBeGreaterThanOrEqual(30);
    const all = [...real.routes.flatMap((r) => r.messages), ...real.unsure];
    expect(new Set(all).size).toBe(all.length);
  });

  it('splits reproducibly from a seed, with the requested examples and the rest held out', () => {
    expect([mulberry32(7)(), mulberry32(7)()]).toEqual([mulberry32(7)(), mulberry32(7)()]);
    const [a] = prepareSplits(set, embeddings, {
      mode: 'centroid',
      examplesPerRoute: 4,
      seeds: [3],
    });
    const [b] = prepareSplits(set, embeddings, {
      mode: 'centroid',
      examplesPerRoute: 4,
      seeds: [3],
    });
    expect(a?.tests.map((t) => t.text)).toEqual(b?.tests.map((t) => t.text));
    // 6 held out per route, plus both unsure messages.
    expect(a?.tests).toHaveLength(14);
  });

  it('NF-A3: ships translated sets that match the English set message for message', () => {
    const english = loadEvaluationSet();
    for (const lang of ['de', 'fr', 'es', 'sv']) {
      const translated = loadEvaluationSet(
        EVALUATION_SET_PATH.replace(/routing-v1\.json$/, `routing-v1.${lang}.json`),
      );
      expect(translated.routes.map((r) => [r.name, r.direction, r.messages.length])).toEqual(
        english.routes.map((r) => [r.name, r.direction, r.messages.length]),
      );
      expect(translated.unsure).toHaveLength(english.unsure.length);
      const all = [...translated.routes.flatMap((r) => r.messages), ...translated.unsure];
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('NF-A3: takes examples from a parallel set, splitting it the same way', () => {
    // The same messages under other names, with the same vectors: routes written in one
    // language, tested in another, give exactly the same results.
    const parallel: EvaluationSet = {
      ...set,
      routes: set.routes.map((r) => ({ ...r, messages: r.messages.map((m) => `other ${m}`) })),
    };
    const parallelEmbeddings = new Map(
      [...embeddings].map(([text, vector]) => [`other ${text}`, vector] as const),
    );
    const params = { mode: 'centroid' as const, examplesPerRoute: 4, seeds: [1, 2, 3] };
    const plain = prepareSplits(set, embeddings, params);
    const crossed = prepareSplits(set, embeddings, {
      ...params,
      examplesFrom: { set: parallel, embeddings: parallelEmbeddings },
    });
    expect(crossed.map((s) => s.tests.map((t) => [t.text, t.scores]))).toEqual(
      plain.map((s) => s.tests.map((t) => [t.text, t.scores])),
    );
    const missing: EvaluationSet = { ...parallel, routes: parallel.routes.slice(1) };
    expect(() =>
      prepareSplits(set, embeddings, {
        ...params,
        examplesFrom: { set: missing, embeddings: parallelEmbeddings },
      }),
    ).toThrow(/no parallel route alpha/);
  });

  it('counts right routes, "not sure" and misroutes the way AC 11 needs', () => {
    const splits = prepareSplits(set, embeddings, {
      mode: 'centroid',
      examplesPerRoute: 4,
      seeds: [1, 2],
    });
    const strict = aggregate(
      splits.map((s) =>
        measure(
          s,
          { mode: 'centroid', thresholdDown: 0.35, thresholdUp: 0.2, margin: 0 },
          directions,
        ),
      ),
    );
    // Every routed message goes to its own route; the unsure ones are orthogonal and declined.
    expect(strict.clearAccuracy.mean).toBe(1);
    expect(strict.misrouteRate.mean).toBe(0);
    expect(strict.unsureCorrectRate.mean).toBe(1);
    expect(strict.accuracy.mean).toBe(1);

    // Thresholds so high that nothing routes: every clear message becomes "not sure".
    const timid = measure(
      splits[0] ?? { seed: 0, tests: [] },
      { mode: 'centroid', thresholdDown: 1.1, thresholdUp: 1.1, margin: 0 },
      directions,
    );
    expect(timid).toMatchObject({
      clearAccuracy: 0,
      clearNotSureRate: 1,
      noMisrouteRate: 1,
      misrouteRate: 0,
    });
    expect(timid.accuracy).toBeCloseTo(2 / 14);

    const table = confusion(
      splits,
      { mode: 'centroid', thresholdDown: 0.35, thresholdUp: 0.2, margin: 0 },
      directions,
    );
    expect(table).toEqual({ alpha: { alpha: 1 }, beta: { beta: 1 }, unsure: { none: 1 } });
  });

  it('reports a mean with its spread, never a single split', () => {
    expect(spread([0.8, 0.82, 0.84])).toMatchObject({ mean: 0.82, min: 0.8, max: 0.84 });
    expect(spread([0.8, 0.82, 0.84]).std).toBeCloseTo(0.02);
    expect(spread([0.5]).std).toBe(0);
  });

  it('RT-5: the threshold search never tries a cheaper direction that needs less confidence', () => {
    const grid = thresholdGrid();
    expect(grid.length).toBeGreaterThan(100);
    for (const point of grid) expect(point.thresholdDown).toBeGreaterThanOrEqual(point.thresholdUp);
  });

  it("calibrated scoring divides by how tightly a route's examples sit around its centroid", () => {
    const route = {
      id: 'r',
      name: 'r',
      model: 'm',
      fallbacks: [],
      allowCrossProvider: false,
      thresholdDown: 1,
      thresholdUp: 1,
      enabled: true,
      signals: [],
      description: '',
      exampleCount: 2,
      centroid: { embedding: unit(1, 0), model: 'm1', source: 'examples' as const },
      examples: [
        { embedding: unit(1, 1), model: 'm1' },
        { embedding: unit(1, -1), model: 'm1' },
      ],
    };
    expect(cohesionOf(route, 'm1')).toBeCloseTo(Math.SQRT1_2);
    expect(cohesionOf(route, 'other')).toBeUndefined();
  });
});

function rotation(
  descriptions: ReadonlyMap<string, Float32Array>,
  newRouteExamples?: number,
  blend?: 'new' | 'all',
  from: ReadonlyMap<string, Float32Array> = embeddings,
) {
  return prepareFallbackRotation(set, from, {
    examplesPerRoute: 4,
    seeds: [1, 2],
    descriptions,
    ...(newRouteExamples === undefined ? {} : { newRouteExamples }),
    ...(blend === undefined ? {} : { blend }),
  });
}

/** A route's similarity to each of its own held-out messages, where it was the new route. */
function ownScores(splits: ReturnType<typeof rotation>, newRoute: string, route: string) {
  const scores = splits
    .filter((s) => s.route === newRoute)
    .flatMap((s) => s.fallback.tests.filter((t) => t.label === route))
    .map((t) => t.scores?.find((r) => r.routeId === route)?.similarity);
  expect(scores.length).toBeGreaterThan(0);
  return scores;
}

describe('description fallback (RT-12, ADR 0122)', () => {
  const params = { mode: 'centroid' as const, thresholdDown: 0.35, thresholdUp: 0.2, margin: 0 };
  const onAxes = new Map([
    ['alpha', unit(1, 0, 0)],
    ['beta', unit(0, 1, 0)],
  ]);

  it('RT-12: ships three blind description sets that name exactly the evaluation routes', () => {
    const sets = loadDescriptionSets();
    expect(sets.version).toBe(1);
    expect(sets.sets.map((s) => s.name)).toEqual(['blind1', 'blind2', 'blind3']);
    const real = loadEvaluationSet();
    for (const descriptionSet of sets.sets) {
      expect(descriptionSet.provenance).toMatch(/never saw the evaluation set/);
      const rendered = describedRoutes(descriptionSet, real);
      expect([...rendered.keys()]).toEqual(real.routes.map((r) => r.name));
      for (const [name, text] of rendered) expect(text.startsWith(`${name}: `)).toBe(true);
    }
  });

  it('RT-12: embeds a route as its name and its description', () => {
    expect(describedRouteText('legal', '  contracts, NDAs and GDPR ')).toBe(
      'legal: contracts, NDAs and GDPR',
    );
    const only = { name: 'test', provenance: 'p', routes: { alpha: 'a' } };
    expect(() => describedRoutes(only, set)).toThrow(/has no route beta/);
    const extra = { ...only, routes: { alpha: 'a', beta: 'b', gamma: 'c' } };
    expect(() => describedRoutes(extra, set)).toThrow(/names no route gamma/);
  });

  it('RT-12: describes each route in turn, on the same splits as the plain evaluation', () => {
    const splits = rotation(onAxes);
    expect(splits.map((s) => [s.seed, s.route])).toEqual([
      [1, 'alpha'],
      [1, 'beta'],
      [2, 'alpha'],
      [2, 'beta'],
    ]);
    const plain = prepareSplits(set, embeddings, {
      mode: 'centroid',
      examplesPerRoute: 4,
      seeds: [1, 2],
    });
    for (const split of splits) {
      const same = plain.find((p) => p.seed === split.seed);
      expect(split.today.tests.map((t) => t.text)).toEqual(same?.tests.map((t) => t.text));
      expect(split.fallback.tests.map((t) => t.text)).toEqual(same?.tests.map((t) => t.text));
      // Without the fallback the described route is never scored; with it, it is.
      for (const test of split.today.tests)
        expect(test.scores?.some((s) => s.routeId === split.route) ?? false).toBe(false);
      expect(
        split.fallback.tests.some((t) => t.scores?.some((s) => s.routeId === split.route)),
      ).toBe(true);
    }
    expect(() => rotation(new Map([['alpha', unit(1, 0, 0)]]))).toThrow(
      /no description for route beta/,
    );
  });

  it('RT-12: a described route is chosen by its description, as no route at all was before', () => {
    const result = measureFallback(rotation(onAxes), params, directions);
    expect(result.newRouteRecall.today.mean).toBe(0);
    expect(result.newRouteRecall.fallback.mean).toBe(1);
    expect(result.fallback.accuracy.mean).toBeGreaterThan(result.today.accuracy.mean);
    expect(fallbackHolds(result)).toBe(true);
  });

  it("RT-12: uses the description, never the route's own examples, and flags a fallback that does worse", () => {
    // Alpha's description points where the unsure messages are, away from alpha's messages.
    const misleading = new Map([
      ['alpha', unit(0, 0, 1)],
      ['beta', unit(0, 1, 0)],
    ]);
    const alphaOnly = (splits: ReturnType<typeof rotation>) =>
      splits.filter((s) => s.route === 'alpha');
    const described = measureFallback(alphaOnly(rotation(misleading)), params, directions);
    expect(described.newRouteRecall.fallback.mean).toBe(0);
    expect(described.fallback.misrouteRate.mean).toBeGreaterThan(described.today.misrouteRate.mean);
    expect(fallbackHolds(described)).toBe(false);
    // The same rotation with four of alpha's own examples instead routes alpha's messages.
    const trained = measureFallback(alphaOnly(rotation(misleading, 4)), params, directions);
    expect(trained.newRouteRecall.fallback.mean).toBe(1);
  });
});

describe('the description among the examples (RT-12, ADR 0125)', () => {
  const params = { mode: 'centroid' as const, thresholdDown: 0.35, thresholdUp: 0.2, margin: 0 };
  // Every message of a route on its own axis, so a centroid is known whichever examples a seed
  // picks; descriptions on the third axis, away from both.
  const flat = new Map<string, Float32Array>([
    ...words('alpha').map((t) => [t, unit(1, 0, 0)] as const),
    ...words('beta').map((t) => [t, unit(0, 1, 0)] as const),
    ['what is the weather like today', unit(0.1, 0.1, 1)],
    ['tell me something', unit(0, 0, 1)],
  ]);
  const offAxis = new Map([
    ['alpha', unit(0, 0, 1)],
    ['beta', unit(0, 0, 1)],
  ]);

  it("RT-12: blending adds the description to the new route's examples with the weight of one", () => {
    // One example and the description: the mean of (1, 0, 0) and (0, 0, 1), normalized.
    for (const score of ownScores(rotation(offAxis, 1, 'new', flat), 'alpha', 'alpha'))
      expect(score).toBeCloseTo(1 / Math.SQRT2, 6);
    // Three examples and the description: (3, 0, 1), normalized.
    for (const score of ownScores(rotation(offAxis, 3, 'new', flat), 'alpha', 'alpha'))
      expect(score).toBeCloseTo(3 / Math.sqrt(10), 6);
    // Without blending, examples alone.
    for (const score of ownScores(rotation(offAxis, 3, undefined, flat), 'alpha', 'alpha'))
      expect(score).toBeCloseTo(1, 6);
    // Blending only the new route leaves the others' examples alone.
    for (const score of ownScores(rotation(offAxis, 3, 'new', flat), 'alpha', 'beta'))
      expect(score).toBeCloseTo(1, 6);
    expect(() => rotation(offAxis, undefined, 'new')).toThrow(/needs newRouteExamples/);
    expect(() => rotation(new Map([['beta', unit(0, 0, 1)]]), 1, 'new')).toThrow(
      /no description for route alpha/,
    );
  });

  it('RT-12: with every route described, each route blends its own description', () => {
    // Beta keeps its four examples and gains its description: (0, 4, 1), normalized.
    for (const score of ownScores(rotation(offAxis, 1, 'all', flat), 'alpha', 'beta'))
      expect(score).toBeCloseTo(4 / Math.sqrt(17), 6);
    expect(() => rotation(new Map([['alpha', unit(0, 0, 1)]]), 1, 'all')).toThrow(
      /no description for route beta/,
    );
  });

  it('RT-12: flags a blended centroid that does worse than examples alone', () => {
    const examples = measureFallback(rotation(new Map(), 1), params, directions);
    const onAxes = new Map([
      ['alpha', unit(1, 0, 0)],
      ['beta', unit(0, 1, 0)],
    ]);
    const good = measureFallback(rotation(onAxes, 1, 'new'), params, directions);
    expect(blendHolds(examples, good)).toBe(true);
    // Alpha's description points where the unsure messages are, so a new alpha takes them.
    const misleading = new Map([
      ['alpha', unit(0, 0, 1)],
      ['beta', unit(0, 1, 0)],
    ]);
    const bad = measureFallback(rotation(misleading, 1, 'new'), params, directions);
    expect(blendHolds(examples, bad)).toBe(false);
  });

  it('RT-12: gates every case but the new route at twelve examples', () => {
    expect(BLEND_CASES.map((c) => [c.name, c.gated])).toEqual([
      ['new_1', true],
      ['new_2', true],
      ['new_4', true],
      ['new_12', false],
      ['all_12', true],
    ]);
  });
});
