import { describe, expect, it } from 'vitest';
import { suggestTargetRoute } from '../src/routing/candidates.ts';

const routes = [
  { id: 'r-code', name: 'code', model: 'p:strong' },
  { id: 'r-docs', name: 'docs', model: 'p:mid' },
  { id: 'r-summary', name: 'summary', model: 'p:cheap' },
  { id: 'r-review', name: 'review', model: 'p:strong' },
];

describe('where a route example candidate could go (RT-10, ADR 0114)', () => {
  it('RT-10: a candidate is never suggested for the route people moved away from', () => {
    // People left summary for the strong model: the routes on it come first, summary never.
    expect(suggestTargetRoute(routes, 'p:strong', 'r-summary')).toEqual([
      { kind: 'route', routeId: 'r-code', name: 'code' },
      { kind: 'route', routeId: 'r-review', name: 'review' },
      { kind: 'route', routeId: 'r-docs', name: 'docs' },
      { kind: 'new', model: 'p:strong' },
    ]);
    // Even when the route people left uses the model they chose (a route chosen by name).
    const targets = suggestTargetRoute(routes, 'p:strong', 'r-code');
    expect(targets.map((t) => (t.kind === 'route' ? t.routeId : t.kind))).toEqual([
      'r-review',
      'r-docs',
      'r-summary',
      'new',
    ]);
  });

  it('RT-10: with no other route, the only place is a new route with the chosen model', () => {
    const summary = { id: 'r-summary', name: 'summary', model: 'p:cheap' };
    expect(suggestTargetRoute([summary], 'p:mid', 'r-summary')).toEqual([
      { kind: 'new', model: 'p:mid' },
    ]);
    expect(suggestTargetRoute([], 'p:mid', 'r-gone')).toEqual([{ kind: 'new', model: 'p:mid' }]);
  });
});
