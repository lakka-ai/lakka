import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelView, ProviderConfigView } from '@lakka/contracts';
import { createLogger, dispatch, fixedCatalogue, loadCatalogue } from '@lakka/core';
import { listUsageForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * M2 exit criterion 1 (docs/gates/m2.md): a request routed to any configured provider returns
 * a correct cost record. One request per provider kind goes through dispatch over real HTTP,
 * each speaking that provider's own protocol, and its usage row is checked against a hand
 * calculation from the tokens the provider reported.
 */

let t: TestApp;
let fake: FakeProvider;
let admin: SignedInUser;
const workspaceId = randomUUID();
const catalogue = fixedCatalogue(loadCatalogue());
const { logger } = createLogger({ level: 'silent', service: 'm2-exit' });
const configs = new Map<string, ProviderConfigView>();

// $1, $2, $0.10 and $1.25 per million tokens for input, output, cache reads and cache writes.
const PRICES = {
  inputMicroUsdPerMtok: 1_000_000,
  outputMicroUsdPerMtok: 2_000_000,
  cacheReadMicroUsdPerMtok: 100_000,
  cacheWriteMicroUsdPerMtok: 1_250_000,
};

async function model(provider: string): Promise<string> {
  const res = await as(t, admin).post('/api/models/custom', {
    provider,
    model: `ok~${randomBytes(3).toString('hex')}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
      pdf: false,
      tools: false,
      structuredOutput: false,
      promptCaching: true,
      reasoning: false,
    },
    prices: PRICES,
  });
  return (res.json() as { model: ModelView }).model.id;
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  admin = await signedInUser(t, 'Admin');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    admin.principal.id,
  ]);
  for (const body of [
    {
      kind: 'openai-compatible',
      name: 'vllm',
      baseUrl: `${fake.url}/openai/v1`,
      apiKey: 'key-vllm',
    },
    { kind: 'anthropic', baseUrl: `${fake.url}/anthropic/v1`, apiKey: 'key-anthropic' },
    { kind: 'openai', baseUrl: `${fake.url}/responses/v1`, apiKey: 'key-openai' },
    { kind: 'google', baseUrl: `${fake.url}/google/v1beta`, apiKey: 'key-google' },
  ]) {
    const created = (
      (await as(t, admin).post('/api/providers', body)).json() as { provider: ProviderConfigView }
    ).provider;
    configs.set(created.name, created);
  }
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('M2 exit criterion 1: a correct cost record from every provider kind', () => {
  const cases = [
    // 18 uncached + 32 cached (reported inside prompt_tokens) + 8 output: 37.2, rounded up.
    { provider: 'vllm', uncached: 18, cacheRead: 32, cacheWrite: 0, output: 8, cost: 38n },
    // 12 uncached + 2000 cache reads + 100 cache writes + 7 output.
    {
      provider: 'anthropic',
      uncached: 12,
      cacheRead: 2000,
      cacheWrite: 100,
      output: 7,
      cost: 351n,
    },
    // Responses API: 2000 of 2100 input tokens cached; 40 output including 30 reasoning.
    { provider: 'openai', uncached: 100, cacheRead: 2000, cacheWrite: 0, output: 40, cost: 380n },
    // Gemini: 1000 of 1500 prompt tokens cached; 20 candidate + 50 thinking tokens billed as output.
    { provider: 'google', uncached: 500, cacheRead: 1000, cacheWrite: 0, output: 70, cost: 740n },
  ] as const;

  for (const c of cases) {
    it(`BG-8: ${c.provider}`, async () => {
      const ref = await model(c.provider);
      const requestId = randomUUID();
      const stream = await dispatch(
        { db: t.db, catalogue, logger },
        {
          requestId,
          surface: 'api',
          workspaceId,
          principal: admin.principal,
          request: { messages: [{ role: 'user', content: 'Say hello' }], maxOutputTokens: 100 },
          candidates: [ref],
          routing: {
            rule: 'explicit',
            routeId: null,
            confidence: null,
            defaultReason: null,
            overriddenModel: null,
            budgetFallbackFrom: null,
          },
        },
      );
      let text = '';
      for await (const e of stream) if (e.type === 'text') text += e.text;
      expect(text).toBe('Hello there');
      expect(await stream.done).toMatchObject({ outcome: 'completed', costMicroUsd: c.cost });

      const [row] = await listUsageForRequest(t.db, workspaceId, requestId);
      expect(row).toMatchObject({
        model: ref,
        provider: c.provider,
        providerConfigId: configs.get(c.provider)?.id,
        uncachedInputTokens: c.uncached,
        cacheReadTokens: c.cacheRead,
        cacheWriteTokens: c.cacheWrite,
        outputTokens: c.output,
        usageEstimated: false,
        costMicroUsd: c.cost,
      });
      // The request reached the configured address with that provider's own key.
      const sent = fake.requests.findLast((r) => r.model === ref.slice(ref.indexOf(':') + 1));
      expect(sent?.authorization).toMatch(new RegExp(`key-${c.provider}$`));
    });
  }
});
