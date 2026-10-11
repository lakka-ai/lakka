import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetExceededError } from '@lakka/contracts';
import type { ModelView, RouteView, WorkspaceView } from '@lakka/contracts';
import {
  createLogger,
  estimateAttemptCost,
  handleModelRequest,
  fixedCatalogue,
  loadCatalogue,
  noClassifier,
  policySnapshots,
  startConversation,
  valkeyEvents,
} from '@lakka/core';
import type { ModelRequest, ModelResponse, PipelineContext } from '@lakka/core';
import { listUsageForRequest } from '@lakka/db';
import { startFakeProvider } from '../../../test/integration/fake-provider.ts';
import type { FakeProvider } from '../../../test/integration/fake-provider.ts';
import { as, createTestApp, signedInUser } from './support.ts';
import type { SignedInUser, TestApp } from './support.ts';

/*
 * Falling back to a cheaper model when a cap has no room (BG-7, Q2, AC 10, ADR 0053): the route's
 * fallbacks, then the workspace default, whichever is most capable and fits; the user is told;
 * refused only when nothing fits.
 */

let t: TestApp;
let fake: FakeProvider;
let root: SignedInUser;
let ws: WorkspaceView;
let ctx: PipelineContext;
let models: { strong: ModelView; mid: ModelView; cheap: ModelView };
let code: RouteView;
const { logger } = createLogger({ level: 'silent', service: 'pipeline-fallback-test' });

const CODE = 'why does this fail?\n```\nprint(1/0)\n```';
const MAX_OUTPUT = 1000;

async function customModel(name: string, input: number, output: number): Promise<ModelView> {
  const res = await as(t, root).post('/api/models/custom', {
    provider: 'fake',
    model: `ok~${name}-${randomBytes(3).toString('hex')}`,
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    capabilities: {
      vision: false,
      pdf: false,
      tools: false,
      structuredOutput: false,
      promptCaching: false,
      reasoning: false,
    },
    prices: {
      inputMicroUsdPerMtok: input,
      outputMicroUsdPerMtok: output,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return (res.json() as { model: ModelView }).model;
}

/** A fresh member with a cap of exactly `microUsd`, so each test starts from a clean slate. */
async function memberWithCap(microUsd: bigint): Promise<SignedInUser> {
  const user = await signedInUser(t, `Member ${randomBytes(2).toString('hex')}`);
  await as(t, root).put(`/api/workspaces/${ws.id}/members/${user.principal.id}`, {
    role: 'member',
  });
  const res = await as(t, root).put(
    `/api/workspaces/${ws.id}/budgets/members/${user.principal.id}`,
    { limitMicroUsd: String(microUsd), period: 'monthly' },
  );
  if (res.statusCode !== 200) throw new Error(res.body);
  return user;
}

function request(
  user: SignedInUser,
  text: string,
  extra: Partial<ModelRequest> = {},
): ModelRequest {
  return {
    requestId: randomUUID(),
    surface: 'api',
    workspaceId: ws.id,
    principal: user.principal,
    request: { messages: [{ role: 'user', content: text }], maxOutputTokens: MAX_OUTPUT },
    model: null,
    conversationId: null,
    ...extra,
  };
}

const estimate = (m: ModelView) => estimateAttemptCost(request(root, CODE).request, m);

async function run(req: ModelRequest): Promise<ModelResponse> {
  const response = await handleModelRequest(ctx, req);
  for await (const event of response.stream) void event;
  await response.stream.done;
  return response;
}

beforeAll(async () => {
  t = await createTestApp();
  fake = await startFakeProvider();
  root = await signedInUser(t, 'Root');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  ws = (
    (
      await as(t, root).post('/api/workspaces', {
        name: 'Fallback',
        slug: `fallback-${randomBytes(3).toString('hex')}`,
      })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  const provider = await as(t, root).post('/api/providers', {
    kind: 'openai-compatible',
    name: 'fake',
    baseUrl: `${fake.url}/openai/v1`,
  });
  if (provider.statusCode !== 201) throw new Error(provider.body);
  models = {
    strong: await customModel('strong', 15_000_000, 75_000_000),
    mid: await customModel('mid', 3_000_000, 15_000_000),
    cheap: await customModel('cheap', 150_000, 600_000),
  };
  const route = await as(t, root).post(`/api/workspaces/${ws.id}/routes`, {
    name: 'code',
    model: models.strong.id,
    fallbacks: [models.mid.id],
    signals: ['code_fence'],
  });
  if (route.statusCode !== 201) throw new Error(route.body);
  code = (route.json() as { route: RouteView }).route;
  await as(t, root).put(`/api/workspaces/${ws.id}/routing/settings`, {
    routingEnabled: true,
    defaultModel: models.cheap.id,
    pinnedModel: null,
  });
  ctx = {
    db: t.db,
    catalogue: fixedCatalogue(loadCatalogue()),
    logger,
    events: valkeyEvents(t.cache, logger),
    cache: t.cache,
    keyPrefix: `fallback-test-${randomBytes(4).toString('hex')}:`,
    classifier: noClassifier,
    snapshots: policySnapshots({ db: t.db }),
  };
});

afterAll(async () => {
  await fake.close();
  await t.close();
});

describe('falling back when a cap has no room (BG-7)', () => {
  it('BG-7: when the routed model does not fit, the most capable fallback that does is used, and the user is told', async () => {
    // The route asks for strong, reserving for strong and its fallback mid; only mid fits.
    const user = await memberWithCap(estimate(models.mid) + 1n);
    const req = request(user, CODE);
    const response = await run(req);
    expect(response.resolution).toMatchObject({ rule: 'signal', model: models.strong.id });
    expect(response.fallback).toEqual({
      from: models.strong.id,
      to: models.mid.id,
      scope: 'member',
    });
    expect(response.reservedMicroUsd).toBe(estimate(models.mid));
    expect(fake.count(models.strong.model)).toBe(0);
    expect(fake.count(models.mid.model)).toBe(1);
    const [usage] = await listUsageForRequest(t.db, ws.id, req.requestId);
    expect(usage).toMatchObject({
      model: models.mid.id,
      resolutionRule: 'signal',
      routeId: code.id,
      budgetFallbackFrom: models.strong.id,
    });
  });

  it("BG-7: when none of the route's fallbacks fit, the workspace default does", async () => {
    const user = await memberWithCap(estimate(models.mid) - 1n);
    const response = await run(request(user, CODE));
    expect(response.fallback).toMatchObject({ from: models.strong.id, to: models.cheap.id });
  });

  it('BG-7, Q2: a model the user chose themselves falls back too, and says so', async () => {
    const user = await memberWithCap(estimate(models.cheap) + 1n);
    const req = request(user, 'hello there, how are you today', { model: models.strong.id });
    const response = await run(req);
    expect(response.resolution.rule).toBe('explicit');
    expect(response.fallback).toEqual({
      from: models.strong.id,
      to: models.cheap.id,
      scope: 'member',
    });
    const [usage] = await listUsageForRequest(t.db, ws.id, req.requestId);
    expect(usage).toMatchObject({
      resolutionRule: 'explicit',
      budgetFallbackFrom: models.strong.id,
    });
  });

  it('BG-7, AC 10: when nothing fits, the request is refused with a machine-readable error and nothing is sent', async () => {
    const before = fake.requests.length;
    const user = await memberWithCap(estimate(models.cheap) - 1n);
    const req = request(user, CODE);
    const error = await handleModelRequest(ctx, req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).toMatchObject({ code: 'budget_exceeded', scope: 'member' });
    expect(fake.requests.length).toBe(before);
    expect(await listUsageForRequest(t.db, ws.id, req.requestId)).toEqual([]);
  });

  it('BG-7: a conversation keeps its routing decision after a fallback, so the next message tries it again', async () => {
    const user = await memberWithCap(estimate(models.mid) + 1n);
    const { id } = await startConversation(ctx, user.principal, ws.id);
    const first = await run(request(user, CODE, { conversationId: id }));
    expect(first.fallback?.to).toBe(models.mid.id);
    const { rows } = await t.pool.query<{ routed_model: string }>(
      'select routed_model from conversations where id = $1',
      [id],
    );
    expect(rows[0]?.routed_model).toBe(models.strong.id);

    await as(t, root).put(`/api/workspaces/${ws.id}/budgets/members/${user.principal.id}`, {
      limitMicroUsd: String(estimate(models.strong) * 10n),
      period: 'monthly',
    });
    const next = await run(request(user, 'and now in rust please', { conversationId: id }));
    expect(next.resolution).toMatchObject({ rule: 'sticky', model: models.strong.id });
    expect(next.fallback).toBeNull();
  });
});
