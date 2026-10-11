import { blendedPrice, NoModelError, UnknownModelError } from '@lakka/contracts';
import type { ModelPrices } from '@lakka/contracts';
import { describe, expect, it, vi } from 'vitest';
import { directionOf, resolveRequestModel } from '../src/routing/resolve.ts';
import type { ResolutionInput } from '../src/routing/resolve.ts';
import type { PolicySnapshot, RouteScore, RouteSnapshot } from '../src/routing/score.ts';

const prices = (inputPrice: number, outputPrice: number): ModelPrices => ({
  inputMicroUsdPerMtok: inputPrice,
  outputMicroUsdPerMtok: outputPrice,
  cacheReadMicroUsdPerMtok: null,
  cacheWriteMicroUsdPerMtok: null,
});
const PRICES: Record<string, ModelPrices> = {
  'p:default': prices(3_000_000, 15_000_000),
  'p:cheap': prices(150_000, 600_000),
  'p:strong': prices(15_000_000, 75_000_000),
  'p:fallback': prices(1_000_000, 5_000_000),
};

type Classify = ResolutionInput['classify'];
const priceOf = (model: string) => Promise.resolve(PRICES[model]);

const trained = { embedding: Float32Array.of(1, 0), model: 'e1', source: 'examples' as const };
const route = (name: string, overrides: Partial<RouteSnapshot> = {}): RouteSnapshot => ({
  id: `id-${name}`,
  name,
  model: 'p:strong',
  fallbacks: [],
  allowCrossProvider: false,
  thresholdDown: 0.35,
  thresholdUp: 0.2,
  enabled: true,
  signals: [],
  description: '',
  exampleCount: 12,
  centroid: trained,
  examples: [],
  ...overrides,
});

const code = route('code', {
  model: 'p:strong',
  fallbacks: ['p:fallback', 'p:strong'],
  allowCrossProvider: true,
  signals: ['code_fence'],
});
const summarize = route('summarize', { model: 'p:cheap', signals: ['code_file'], enabled: false });
const brief = route('brief', { model: 'p:cheap' });

const policy = (overrides: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
  workspaceId: 'ws',
  capture: { enabled: false, retentionDays: 7 },
  version: 3,
  routingEnabled: true,
  defaultModel: 'p:default',
  pinnedModel: null,
  routes: [code, summarize, brief],
  budgets: [],
  tools: [],
  ...overrides,
});

const scored = (...pairs: [RouteSnapshot, number][]): RouteScore[] =>
  pairs.map(([r, similarity]) => ({ routeId: r.id, name: r.name, similarity }));

function input(overrides: Partial<ResolutionInput> = {}): ResolutionInput {
  return {
    policy: policy(),
    explicitModel: null,
    sticky: null,
    text: 'please write a haiku about the sea',
    classify: () => Promise.resolve([]),
    priceOf,
    ...overrides,
  };
}

describe('the resolution order (RT-3)', () => {
  it('RT-3: an explicit user choice wins over everything, even a pin and a sticky route', async () => {
    const classify = vi.fn<Classify>();
    const r = await resolveRequestModel(
      input({
        explicitModel: 'p:cheap',
        sticky: { model: 'p:strong', routeId: code.id },
        policy: policy({ pinnedModel: 'p:fallback' }),
        text: '```\ncode\n```',
        classify,
      }),
    );
    expect(r).toMatchObject({ rule: 'explicit', model: 'p:cheap', fallbacks: [], remember: false });
    expect(classify).not.toHaveBeenCalled();
  });

  it("API-4, G1: a route asked for by name is the caller's own choice, with the route's model and fallbacks", async () => {
    const classify = vi.fn<Classify>();
    const r = await resolveRequestModel(
      input({
        explicitRoute: 'code',
        sticky: { model: 'p:cheap', routeId: brief.id },
        policy: policy({ pinnedModel: 'p:fallback' }),
        classify,
      }),
    );
    expect(r).toMatchObject({
      rule: 'explicit',
      model: 'p:strong',
      routeId: code.id,
      fallbacks: ['p:fallback'],
      allowCrossProvider: true,
      remember: false,
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it('API-4: a route that does not exist, or is off, is refused as an unknown model', async () => {
    await expect(resolveRequestModel(input({ explicitRoute: 'nope' }))).rejects.toBeInstanceOf(
      UnknownModelError,
    );
    // summarize is disabled in this policy.
    await expect(resolveRequestModel(input({ explicitRoute: 'summarize' }))).rejects.toBeInstanceOf(
      UnknownModelError,
    );
  });

  it("RT-7: a routed conversation keeps its model, with the route's current fallbacks", async () => {
    const r = await resolveRequestModel(
      input({ sticky: { model: 'p:strong', routeId: code.id }, text: 'now in Rust please' }),
    );
    expect(r).toEqual({
      rule: 'sticky',
      model: 'p:strong',
      fallbacks: ['p:fallback'],
      allowCrossProvider: true,
      routeId: code.id,
      signal: null,
      confidence: null,
      reason: null,
      threshold: null,
      remember: false,
    });
  });

  it('RT-7: the model stays as decided even after the route was changed or deleted', async () => {
    const r = await resolveRequestModel(
      input({
        sticky: { model: 'p:old', routeId: 'gone' },
        policy: policy({ pinnedModel: 'p:cheap' }),
      }),
    );
    expect(r).toMatchObject({ rule: 'sticky', model: 'p:old', routeId: 'gone', fallbacks: [] });
    const notSure = await resolveRequestModel(
      input({ sticky: { model: 'p:default', routeId: null } }),
    );
    expect(notSure).toMatchObject({ rule: 'sticky', model: 'p:default', routeId: null });
  });

  it('RT-3: a workspace pin wins over signals and the classifier', async () => {
    const classify = vi.fn<Classify>();
    const r = await resolveRequestModel(
      input({ policy: policy({ pinnedModel: 'p:fallback' }), text: '```\nx\n```', classify }),
    );
    expect(r).toMatchObject({ rule: 'pinned', model: 'p:fallback', remember: false });
    expect(classify).not.toHaveBeenCalled();
  });

  it('RT-3: a deterministic signal goes to the enabled route that claims it, without classifying', async () => {
    const classify = vi.fn<Classify>();
    const r = await resolveRequestModel(
      input({ text: 'why does this fail\n```py\nprint(1/0)\n```', classify }),
    );
    expect(r).toMatchObject({
      rule: 'signal',
      model: 'p:strong',
      routeId: code.id,
      signal: 'code_fence',
      fallbacks: ['p:fallback'],
      allowCrossProvider: true,
      confidence: null,
      remember: true,
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it('a signal claimed only by a disabled route, or by none, falls through to the classifier', async () => {
    const classify = vi.fn<Classify>(() => Promise.resolve(scored([brief, 0.9])));
    const r = await resolveRequestModel(
      input({ text: 'tidy up the helpers in utils.py for me', classify }),
    );
    expect(r).toMatchObject({ rule: 'classified', routeId: brief.id });
    expect(classify).toHaveBeenCalledOnce();
  });

  it('RT-3: the classifier picks a route when its best match clears the threshold', async () => {
    const r = await resolveRequestModel(
      input({ classify: () => Promise.resolve(scored([code, 0.42], [brief, 0.3])) }),
    );
    expect(r).toEqual({
      rule: 'classified',
      model: 'p:strong',
      fallbacks: ['p:fallback'],
      allowCrossProvider: true,
      routeId: code.id,
      signal: null,
      confidence: 0.42,
      reason: null,
      // code's model is pricier than the default, so its upward threshold applies (RT-5).
      threshold: code.thresholdUp,
      remember: true,
    });
  });

  it('RT-5: routing to a cheaper model than the default needs the higher threshold', async () => {
    // brief's model is cheaper than the default: 0.3 clears threshold_up (0.2) but not
    // threshold_down (0.35).
    const cheap = await resolveRequestModel(
      input({ classify: () => Promise.resolve(scored([brief, 0.3])) }),
    );
    expect(cheap).toMatchObject({ rule: 'default', reason: 'below_threshold', confidence: 0.3 });
    const pricier = await resolveRequestModel(
      input({ classify: () => Promise.resolve(scored([code, 0.3])) }),
    );
    expect(pricier).toMatchObject({ rule: 'classified', routeId: code.id });
    expect(
      (await resolveRequestModel(input({ classify: () => Promise.resolve(scored([brief, 0.36])) })))
        .rule,
    ).toBe('classified');
  });

  it('RT-6: "not sure" goes to the default, never to the runner-up, and the conversation keeps it', async () => {
    const r = await resolveRequestModel(
      input({ classify: () => Promise.resolve(scored([brief, 0.3], [code, 0.29])) }),
    );
    expect(r).toMatchObject({
      rule: 'default',
      model: 'p:default',
      routeId: null,
      reason: 'below_threshold',
      confidence: 0.3,
      remember: true,
    });
    const close = await resolveRequestModel(
      input({ classify: () => Promise.resolve(scored([code, 0.5], [brief, 0.49])), margin: 0.02 }),
    );
    expect(close).toMatchObject({ rule: 'default', reason: 'ambiguous', remember: true });
  });

  it('RT-6: without anything to classify with, the default is used and nothing is remembered', async () => {
    const classify = vi.fn<Classify>(() => Promise.resolve(undefined));
    expect(await resolveRequestModel(input({ text: 'shorter please', classify }))).toMatchObject({
      rule: 'default',
      reason: 'too_short',
      confidence: null,
      remember: false,
    });
    expect(classify).not.toHaveBeenCalled();

    expect(await resolveRequestModel(input({ classify }))).toMatchObject({
      rule: 'default',
      reason: 'classifier_unavailable',
      remember: false,
    });

    const untrained = policy({ routes: [route('new', { centroid: null })] });
    classify.mockClear();
    expect(await resolveRequestModel(input({ policy: untrained, classify }))).toMatchObject({
      rule: 'default',
      reason: 'no_routes',
      remember: false,
    });
    expect(classify).not.toHaveBeenCalled();

    // Centroids from an older embedding model score nothing until they are recompiled.
    expect(await resolveRequestModel(input({ classify: () => Promise.resolve([]) }))).toMatchObject(
      { rule: 'default', reason: 'no_routes', remember: false },
    );
  });

  it("RT-11: with routing off only the user's choice, the pin and the default apply", async () => {
    const classify = vi.fn<Classify>();
    const off = policy({ routingEnabled: false });
    const r = await resolveRequestModel(
      input({
        policy: off,
        sticky: { model: 'p:strong', routeId: code.id },
        text: '```\nconst x = 1\n```',
        classify,
      }),
    );
    expect(r).toMatchObject({
      rule: 'default',
      model: 'p:default',
      reason: 'routing_off',
      remember: false,
    });
    expect(classify).not.toHaveBeenCalled();
    expect(
      (await resolveRequestModel(input({ policy: { ...off, pinnedModel: 'p:cheap' } }))).rule,
    ).toBe('pinned');
    expect((await resolveRequestModel(input({ policy: off, explicitModel: 'p:cheap' }))).rule).toBe(
      'explicit',
    );
  });

  it('refuses with a typed error when nothing chose a model and there is no default', async () => {
    await expect(
      resolveRequestModel(input({ policy: policy({ defaultModel: null, routingEnabled: false }) })),
    ).rejects.toBeInstanceOf(NoModelError);
    // A pin or a route still works without a default.
    expect(
      (
        await resolveRequestModel(
          input({ policy: policy({ defaultModel: null }), text: '```\nx\n```' }),
        )
      ).rule,
    ).toBe('signal');
  });
});

// (3*2 + 8) / 4 = 3.5 and (3*3 + 5) / 4 = 3.5
const samePrice = (model: string) =>
  Promise.resolve(model === 'a' ? prices(2, 8) : model === 'b' ? prices(3, 5) : undefined);

describe('direction of a route (RT-5, E4)', () => {
  it('compares blended prices, weighting input three to one', async () => {
    expect(blendedPrice(prices(4, 8))).toBe(5);
    expect(await directionOf('p:cheap', 'p:default', priceOf)).toBe('down');
    expect(await directionOf('p:strong', 'p:default', priceOf)).toBe('up');
    expect(await directionOf('p:default', 'p:default', priceOf)).toBe('up');
  });

  it('a model priced the same as the default counts as up', async () => {
    expect(await directionOf('a', 'b', samePrice)).toBe('up');
  });

  it('treats an unknown comparison as cheaper, so it needs the higher threshold', async () => {
    expect(await directionOf('p:strong', null, priceOf)).toBe('down');
    expect(await directionOf('p:unpriced', 'p:default', priceOf)).toBe('down');
    expect(await directionOf('p:strong', 'p:unpriced', priceOf)).toBe('down');
  });
});
