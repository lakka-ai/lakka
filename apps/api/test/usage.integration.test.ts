import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@lakka/contracts';
import { loadCatalogue, priceUsage, recordUsage } from '@lakka/core';
import { listUsageForRequest } from '@lakka/db';
import { createTestApp } from './support.ts';
import type { TestApp } from './support.ts';

/* Recording usage through core (BG-8, ADR 0039) against real Postgres. */

let t: TestApp;
const catalogue = loadCatalogue();

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe('usage records', () => {
  it("BG-8, RT-8: a key's spend is attributed to the key and to the person it acts for, at the prices charged, with the rule that chose the model", async () => {
    const workspaceId = randomUUID();
    const requestId = randomUUID();
    const routeId = randomUUID();
    const key: Principal = {
      id: randomUUID(),
      kind: 'key',
      displayName: 'ci',
      actingUserId: randomUUID(),
      isInstanceAdmin: false,
      workspaceScope: workspaceId,
    };
    const model = catalogue.models.get('anthropic:claude-sonnet-4-5');
    if (model === undefined) throw new Error('catalogue is missing claude-sonnet-4-5');
    const priced = priceUsage(
      {
        inputTokens: 2112,
        uncachedInputTokens: 12,
        cacheReadTokens: 2000,
        cacheWriteTokens: 100,
        outputTokens: 7,
        reasoningTokens: null,
      },
      model,
      { inputTokens: 0, outputTokens: 0 },
    );
    await recordUsage(t, {
      requestId,
      attempt: 1,
      outcome: 'completed',
      surface: 'api',
      workspaceId,
      principal: key,
      model: model.id,
      provider: model.provider,
      providerConfigId: null,
      priced,
      finishReason: 'stop',
      latencyMs: 812.4,
      ttftMs: 230.6,
      routing: {
        rule: 'classified',
        routeId,
        confidence: 0.42,
        defaultReason: null,
        overriddenModel: null,
        budgetFallbackFrom: null,
      },
    });

    const [row] = await listUsageForRequest(t.db, workspaceId, requestId);
    expect(row).toMatchObject({
      principalId: key.id,
      actingUserId: key.actingUserId,
      surface: 'api',
      outcome: 'completed',
      model: 'anthropic:claude-sonnet-4-5',
      uncachedInputTokens: 12,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
      outputTokens: 7,
      usageEstimated: false,
      inputMicroUsdPerMtok: 3_000_000,
      cacheWriteMicroUsdPerMtok: 3_750_000,
      costMicroUsd: 1116n,
      latencyMs: 812,
      ttftMs: 231,
      resolutionRule: 'classified',
      routeId,
      routeConfidence: 0.42,
      defaultReason: null,
      wasOverridden: false,
      overriddenModel: null,
    });
    // Tenant scoping: the same request id read through another workspace finds nothing.
    expect(await listUsageForRequest(t.db, randomUUID(), requestId)).toEqual([]);
  });
});
