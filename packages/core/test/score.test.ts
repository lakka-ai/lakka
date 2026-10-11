import { describe, expect, it } from 'vitest';
import type { CentroidSource } from '@lakka/contracts';
import {
  centroidOf,
  centroidStale,
  describedRouteText,
  dot,
  scoreRoutes,
  scoringBasis,
  worthClassifying,
} from '../src/routing/score.ts';
import type { PolicySnapshot, RouteSnapshot } from '../src/routing/score.ts';

const unit = (...v: number[]) => {
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
};

const route = (name: string, overrides: Partial<RouteSnapshot> = {}): RouteSnapshot => ({
  id: `id-${name}`,
  name,
  model: 'fake:m',
  fallbacks: [],
  allowCrossProvider: false,
  thresholdDown: 0.75,
  thresholdUp: 0.55,
  enabled: true,
  signals: [],
  description: '',
  exampleCount: 1,
  centroid: null,
  examples: [],
  ...overrides,
});

const centroid = (model: string, source: CentroidSource) => ({
  embedding: unit(1, 0),
  model,
  source,
});

const snapshot = (routes: RouteSnapshot[]): PolicySnapshot => ({
  workspaceId: 'ws',
  capture: { enabled: false, retentionDays: 7 },
  version: 1,
  routingEnabled: true,
  defaultModel: null,
  pinnedModel: null,
  routes,
  budgets: [],
  tools: [],
});

describe('route scoring (ADR 0043)', () => {
  it('computes a unit-length centroid, the mean direction of the examples', () => {
    const c = centroidOf([
      [1, 0],
      [0, 1],
    ]);
    expect(c[0]).toBeCloseTo(Math.SQRT1_2);
    expect(c[1]).toBeCloseTo(Math.SQRT1_2);
    expect(centroidOf([])).toEqual([]);
  });

  it('ranks enabled routes by similarity to their centroid, using only vectors from the current model', () => {
    const s = snapshot([
      route('code', { centroid: { embedding: unit(1, 0), model: 'm1', source: 'examples' } }),
      route('writing', {
        centroid: { embedding: unit(0.6, 0.8), model: 'm1', source: 'examples' },
      }),
      route('stale', { centroid: { embedding: unit(1, 0), model: 'm0', source: 'examples' } }),
      route('off', {
        enabled: false,
        centroid: { embedding: unit(1, 0), model: 'm1', source: 'examples' },
      }),
    ]);
    const scores = scoreRoutes(s, unit(1, 0), 'm1', 'centroid');
    expect(scores.map((x) => x.name)).toEqual(['code', 'writing']);
    expect(scores[0]?.similarity).toBeCloseTo(1);
    expect(scores[1]?.similarity).toBeCloseTo(0.6);
  });

  it('nearest-example mode scores a route by its closest example, which a blurred centroid can miss', () => {
    // Examples in two opposite clusters average to a centroid that matches neither.
    const split = route('split', {
      centroid: { embedding: unit(0, 1), model: 'm1', source: 'examples' },
      examples: [
        { embedding: unit(1, 0.1), model: 'm1' },
        { embedding: unit(-1, 0.1), model: 'm1' },
      ],
    });
    const query = unit(1, 0);
    expect(scoreRoutes(snapshot([split]), query, 'm1', 'centroid')[0]?.similarity).toBeCloseTo(
      0,
      1,
    );
    expect(
      scoreRoutes(snapshot([split]), query, 'm1', 'nearest_example')[0]?.similarity,
    ).toBeGreaterThan(0.99);
  });

  it('never compares vectors of different sizes', () => {
    expect(Number.isNaN(dot(unit(1, 0), unit(1, 0, 0)))).toBe(true);
    const s = snapshot([
      route('odd', { centroid: { embedding: unit(1, 0, 0), model: 'm1', source: 'examples' } }),
    ]);
    expect(scoreRoutes(s, unit(1, 0), 'm1', 'centroid')).toEqual([]);
  });

  it('skips messages too short to carry a signal', () => {
    expect(worthClassifying('make it shorter')).toBe(true);
    expect(worthClassifying('shorter please')).toBe(false);
    expect(worthClassifying('   ')).toBe(false);
  });
});

describe('scoring a route from its description (RT-12, ADR 0122, ADR 0125)', () => {
  it('RT-12: a route is scored from its examples and description, its examples, its description, or not at all', () => {
    expect(scoringBasis({ exampleCount: 3, description: 'contracts' })).toBe(
      'examples_and_description',
    );
    expect(scoringBasis({ exampleCount: 1, description: '' })).toBe('examples');
    expect(scoringBasis({ exampleCount: 1, description: '  ' })).toBe('examples');
    expect(scoringBasis({ exampleCount: 0, description: 'contracts and NDAs' })).toBe(
      'description',
    );
    expect(scoringBasis({ exampleCount: 0, description: '   ' })).toBeNull();
    expect(describedRouteText('legal', 'contracts and NDAs')).toBe('legal: contracts and NDAs');
  });

  it('RT-12: a description centroid is scored like any other, against the current model', () => {
    const s = snapshot([
      route('legal', {
        exampleCount: 0,
        description: 'contracts',
        centroid: { embedding: unit(0, 1), model: 'm1', source: 'description' },
      }),
      route('code', { centroid: { embedding: unit(1, 0), model: 'm1', source: 'examples' } }),
    ]);
    expect(scoreRoutes(s, unit(0.1, 1), 'm1', 'centroid').map((x) => x.name)).toEqual([
      'legal',
      'code',
    ]);
    expect(scoreRoutes(s, unit(0.1, 1), 'm2', 'centroid')).toEqual([]);
  });

  it("RT-12: a centroid from another source than the route's basis is stale", () => {
    const trained = { exampleCount: 2, description: 'contracts' };
    expect(
      centroidStale({ ...trained, centroid: centroid('m1', 'examples_and_description') }, 'm1'),
    ).toBe(false);
    // Compiled before ADR 0125, from the examples alone, or under another model, or not at all.
    expect(centroidStale({ ...trained, centroid: centroid('m1', 'examples') }, 'm1')).toBe(true);
    expect(
      centroidStale({ ...trained, centroid: centroid('m0', 'examples_and_description') }, 'm1'),
    ).toBe(true);
    expect(centroidStale({ ...trained, centroid: null }, 'm1')).toBe(true);
    // The description cleared since, or the route's first example added since.
    expect(
      centroidStale(
        { exampleCount: 2, description: '', centroid: centroid('m1', 'examples_and_description') },
        'm1',
      ),
    ).toBe(true);
    expect(
      centroidStale(
        { exampleCount: 1, description: 'contracts', centroid: centroid('m1', 'description') },
        'm1',
      ),
    ).toBe(true);
    // A route with nothing to score from is never stale: there is nothing to compile.
    expect(centroidStale({ exampleCount: 0, description: '', centroid: null }, 'm1')).toBe(false);
  });
});
