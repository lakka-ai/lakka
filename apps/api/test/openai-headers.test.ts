import { describe, expect, it } from 'vitest';
import { decisionHeaders } from '../src/openai/headers.ts';

/* The routing and budget decisions a response reports in its headers (G3, CH-2, CH-4). */

const classified = {
  resolution: {
    rule: 'classified' as const,
    model: 'anthropic:claude-sonnet-4-5',
    fallbacks: [],
    allowCrossProvider: false,
    routeId: 'r1',
    signal: null,
    confidence: 0.9162,
    reason: null,
    threshold: 0.25,
    remember: true,
  },
  routeName: 'code',
  fallback: null,
  stream: { model: { id: 'anthropic:claude-sonnet-4-5' } },
};

describe('decision headers', () => {
  it('CH-2: a classified request says how sure the classifier was, to two decimal places', () => {
    expect(decisionHeaders('req-1', classified)).toEqual({
      'x-lakka-request-id': 'req-1',
      'x-lakka-model': 'anthropic:claude-sonnet-4-5',
      'x-lakka-routing-rule': 'classified',
      'x-lakka-route': 'code',
      'x-lakka-routing-confidence': '0.92',
    });
  });

  it('CH-4: a budget fallback names the model it came from and the cap that sent it', () => {
    const headers = decisionHeaders('req-2', {
      ...classified,
      resolution: { ...classified.resolution, confidence: null },
      fallback: {
        from: 'anthropic:claude-sonnet-4-5',
        to: 'anthropic:claude-haiku-4-5',
        scope: 'workspace' as const,
      },
      stream: { model: { id: 'anthropic:claude-haiku-4-5' } },
    });
    expect(headers['x-lakka-fallback-from']).toBe('anthropic:claude-sonnet-4-5');
    expect(headers['x-lakka-fallback-scope']).toBe('workspace');
    expect(headers['x-lakka-routing-confidence']).toBeUndefined();
  });
});
