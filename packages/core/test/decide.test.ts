import { describe, expect, it } from 'vitest';
import { decideRoute } from '../src/routing/decide.ts';
import type { Direction } from '../src/routing/decide.ts';

const thresholds = (direction: Direction) => () => ({
  thresholdDown: 0.35,
  thresholdUp: 0.2,
  direction,
});
const scores = (...pairs: [string, number][]) =>
  pairs.map(([routeId, similarity]) => ({ routeId, name: routeId, similarity }));

describe('decideRoute (RT-5, RT-6)', () => {
  it('RT-5: a route cheaper than the default needs the higher threshold', () => {
    expect(decideRoute(scores(['summarize', 0.3]), thresholds('down'))).toEqual({
      routeId: null,
      reason: 'below_threshold',
      similarity: 0.3,
    });
    expect(decideRoute(scores(['code', 0.3]), thresholds('up'))).toEqual({
      routeId: 'code',
      similarity: 0.3,
      threshold: 0.2,
    });
  });

  it('RT-6: below the threshold the answer is "not sure", never the runner-up', () => {
    const decision = decideRoute(scores(['summarize', 0.34], ['code', 0.3]), (id) =>
      id === 'summarize'
        ? { thresholdDown: 0.35, thresholdUp: 0.2, direction: 'down' }
        : { thresholdDown: 0.35, thresholdUp: 0.2, direction: 'up' },
    );
    expect(decision.routeId).toBeNull();
  });

  it('declines when the best two are too close to tell apart', () => {
    expect(decideRoute(scores(['a', 0.5], ['b', 0.49]), thresholds('up'), 0.02)).toMatchObject({
      routeId: null,
      reason: 'ambiguous',
    });
    expect(decideRoute(scores(['a', 0.5], ['b', 0.47]), thresholds('up'), 0.02).routeId).toBe('a');
  });

  it('says so when there is nothing to route to', () => {
    expect(decideRoute([], thresholds('up'))).toEqual({
      routeId: null,
      reason: 'no_routes',
      similarity: null,
    });
    expect(decideRoute(scores(['gone', 0.9]), () => undefined).routeId).toBeNull();
  });
});
