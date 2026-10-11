import { describe, expect, it } from 'vitest';
import type { GatewayRequest, ModelView, Principal } from '@lakka/contracts';
import { chargeLines } from '../src/budgets/engine.ts';
import { estimateAttemptCost, estimateRequestCost } from '../src/budgets/estimate.ts';
import type { BudgetSnapshot, PolicySnapshot } from '../src/routing/score.ts';

const model = (overrides: Partial<ModelView> = {}): ModelView => ({
  id: 'p:m',
  provider: 'p',
  model: 'm',
  displayName: 'M',
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  capabilities: {
    vision: false,
    pdf: false,
    tools: false,
    structuredOutput: false,
    promptCaching: true,
    reasoning: false,
  },
  prices: {
    inputMicroUsdPerMtok: 3_000_000,
    outputMicroUsdPerMtok: 15_000_000,
    cacheReadMicroUsdPerMtok: 300_000,
    cacheWriteMicroUsdPerMtok: 3_750_000,
  },
  tiers: [],
  source: 'custom',
  customModelId: null,
  priceUpdated: false,
  ...overrides,
});

// "hello" is 5 bytes: 3 tokens at the upper reading, plus 8 for the message: 11 input tokens.
const hello = (maxOutputTokens?: number): GatewayRequest => ({
  messages: [{ role: 'user', content: 'hello' }],
  ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
});

describe('the estimate reserved before sending (BG-2)', () => {
  it('BG-2: prompt tokens at the dearer of input and cache-write prices, plus the requested output', () => {
    // 11 * 3.75 + 100 * 15 = 1541.25 micro-USD, rounded up.
    expect(estimateAttemptCost(hello(100), model())).toBe(1542n);
  });

  it("BG-2: without a requested maximum, the model's own maximum output is reserved (F2)", () => {
    // 11 * 3.75 + 8192 * 15 = 122921.25
    expect(estimateAttemptCost(hello(), model())).toBe(122_922n);
  });

  it('BG-2: a missing cache-write price counts as the input price; a long-context tier applies', () => {
    const noCachePrice = model({
      prices: { ...model().prices, cacheWriteMicroUsdPerMtok: null },
    });
    // 11 * 3 + 100 * 15 = 1533
    expect(estimateAttemptCost(hello(100), noCachePrice)).toBe(1533n);
    const tiered = model({
      tiers: [
        {
          aboveInputTokens: 10,
          prices: {
            inputMicroUsdPerMtok: 6_000_000,
            outputMicroUsdPerMtok: 22_500_000,
            cacheReadMicroUsdPerMtok: 600_000,
            cacheWriteMicroUsdPerMtok: 7_500_000,
          },
        },
      ],
    });
    // 11 input tokens pass the 10-token threshold: 11 * 7.5 + 100 * 22.5 = 2332.5
    expect(estimateAttemptCost(hello(100), tiered)).toBe(2333n);
  });

  it('F3: a request reserves for its most expensive candidate, and never for none', () => {
    const cheap = model({
      id: 'p:cheap',
      prices: {
        inputMicroUsdPerMtok: 100_000,
        outputMicroUsdPerMtok: 400_000,
        cacheReadMicroUsdPerMtok: null,
        cacheWriteMicroUsdPerMtok: null,
      },
    });
    expect(estimateRequestCost(hello(100), [cheap, model()])).toBe(1542n);
    expect(estimateRequestCost(hello(100), [model(), cheap])).toBe(1542n);
    expect(() => estimateRequestCost(hello(100), [])).toThrow(/no candidate/);
  });
});

const budget = (
  id: string,
  scope: BudgetSnapshot['scope'],
  principalId: string | null,
  period: BudgetSnapshot['period'] = 'monthly',
): BudgetSnapshot => ({ id, scope, principalId, limitMicroUsd: 1_000_000n, period });

const policy = (budgets: BudgetSnapshot[]): PolicySnapshot => ({
  workspaceId: 'ws',
  capture: { enabled: false, retentionDays: 7 },
  version: 1,
  routingEnabled: true,
  defaultModel: null,
  pinnedModel: null,
  routes: [],
  budgets,
  tools: [],
});

const user: Principal = {
  id: 'u1',
  kind: 'user',
  displayName: 'Ada',
  actingUserId: 'u1',
  isInstanceAdmin: false,
  workspaceScope: null,
};
const key: Principal = {
  id: 'k1',
  kind: 'key',
  displayName: 'CI',
  actingUserId: 'u1',
  isInstanceAdmin: false,
  workspaceScope: 'ws',
};

describe('which caps a request is charged against (BG-1, invariant 2)', () => {
  const all = policy([
    budget('b-key-1', 'key', 'k1', 'daily'),
    budget('b-member-2', 'member', 'u2'),
    budget('b-member-1', 'member', 'u1'),
    budget('b-ws', 'workspace', null, 'none'),
    budget('b-key-2', 'key', 'k2'),
    budget('b-inst', 'instance', null),
  ]);
  const now = new Date('2026-09-26T15:00:00Z');

  it('BG-1: a person is charged against the instance, the workspace and their own member cap', () => {
    expect(chargeLines(all, user, now).map((l) => l.budgetId)).toEqual([
      'b-inst',
      'b-ws',
      'b-member-1',
    ]);
  });

  it("invariant 2: a key is charged against its owner's caps and its own", () => {
    const lines = chargeLines(all, key, now);
    expect(lines.map((l) => l.budgetId)).toEqual(['b-inst', 'b-ws', 'b-member-1', 'b-key-1']);
    expect(lines.map((l) => l.periodStart.toISOString())).toEqual([
      '2026-09-01T00:00:00.000Z',
      '1970-01-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-09-26T00:00:00.000Z',
    ]);
  });

  it('BG-1: with no caps, nothing is charged', () => {
    expect(chargeLines(policy([]), key, now)).toEqual([]);
  });
});
