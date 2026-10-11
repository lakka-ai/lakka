import {
  InvalidRequestError,
  NoModelError,
  NotFoundError,
  SignalClaimedError,
  UnknownModelError,
} from '@lakka/contracts';
import type {
  ModelView,
  Principal,
  RouteBody,
  RouteView,
  RoutingPolicyView,
  RoutingSettingsBody,
  TryPhraseDecision,
  TryPhraseResult,
} from '@lakka/contracts';
import {
  deleteRoute,
  findRoutingSettings,
  insertRoute,
  listRouteExamples,
  listRoutes,
  listUsableProviderNames,
  updateRoute,
  updateRoutingSettings,
} from '@lakka/db';
import type { Db, FromCandidates, RouteRow } from '@lakka/db';
import type { ClassifierRuntime } from '../classifier/runtime.ts';
import type { ServiceContext } from '../context.ts';
import type { Logger } from '../logger.ts';
import type { CatalogueStore } from '../models/catalogue.ts';
import { allModels, findModelPrices, resolveModel } from '../models/service.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';
import { compileWorkspacePolicy } from './compile.ts';
import {
  centroidStale,
  DEFAULT_MATCH_MODE,
  dot,
  scoreRoutes,
  scoringBasis,
  worthClassifying,
} from './score.ts';
import type { PolicySnapshot, RouteScore } from './score.ts';
import { directionOf, resolveRequestModel } from './resolve.ts';
import type { PolicySnapshots } from './snapshot.ts';

/*
 * Managing a workspace's routing policy (RT-1, RT-2, RT-11, ADR 0042). Workspace admins and
 * instance admins manage it; members and keys cannot. A route may only name models this
 * workspace can actually use: known and priced (BG-4), with a credential for their provider
 * (PR-8). Without cross-provider failover, fallbacks must share the route model's provider,
 * because dispatch would ignore the others anyway (ADR 0040).
 */

export interface RoutingContext extends ServiceContext {
  catalogue: CatalogueStore;
  classifier: ClassifierRuntime;
  snapshots: PolicySnapshots;
  logger: Logger;
}

/**
 * Routes whose centroid is missing or from another embedding model, while they have examples or
 * a description to make one from (RT-12).
 */
function staleRoutes(snapshot: PolicySnapshot, model: string): string[] {
  return snapshot.routes.filter((r) => centroidStale(r, model)).map((r) => r.name);
}

function routeView(row: RouteRow): RouteView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    model: row.model,
    fallbacks: row.fallbacks,
    allowCrossProvider: row.allowCrossProvider,
    thresholdDown: row.thresholdDown,
    thresholdUp: row.thresholdUp,
    enabled: row.enabled,
    signals: row.signals,
    examples: row.examples,
    compiled:
      row.centroid === null
        ? null
        : {
            at: row.centroid.computedAt.toISOString(),
            model: row.centroid.embeddingModel,
            exampleCount: row.centroid.exampleCount,
            source: row.centroid.source,
          },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Models this workspace can call: priced, with a credential for their provider. */
export async function usableModels(
  ctx: { db: Db; catalogue: CatalogueStore },
  workspaceId: string,
): Promise<ModelView[]> {
  const providers = await listUsableProviderNames(ctx.db, workspaceId);
  return (await allModels(ctx)).filter((m) => providers.has(m.provider));
}

async function requireUsable(
  ctx: RoutingContext,
  workspaceId: string,
  ref: string,
  field: string,
): Promise<ModelView> {
  let model: ModelView;
  try {
    model = await resolveModel(ctx, ref);
  } catch (error) {
    if (error instanceof UnknownModelError) {
      throw new InvalidRequestError(
        `${field}: the model is not in the catalogue or among custom models`,
      );
    }
    throw error;
  }
  if (!(await listUsableProviderNames(ctx.db, workspaceId)).has(model.provider)) {
    throw new InvalidRequestError(
      `${field}: no credential for this model's provider in this workspace`,
    );
  }
  return model;
}

async function validateRoute(
  ctx: RoutingContext,
  workspaceId: string,
  body: RouteBody,
  routeId: string | null,
): Promise<void> {
  const model = await requireUsable(ctx, workspaceId, body.model, 'model');
  for (const fallback of body.fallbacks) {
    const f = await requireUsable(ctx, workspaceId, fallback, 'fallbacks');
    if (!body.allowCrossProvider && f.provider !== model.provider) {
      throw new InvalidRequestError(
        'fallbacks: a fallback from another provider needs allowCrossProvider',
      );
    }
  }
  if (body.signals.length > 0) {
    const others = (await listRoutes(ctx.db, workspaceId)).filter((r) => r.id !== routeId);
    for (const signal of body.signals) {
      if (others.some((r) => r.signals.includes(signal))) {
        throw new SignalClaimedError(`another route already claims the ${signal} signal`);
      }
    }
  }
}

export async function listWorkspaceModels(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
): Promise<ModelView[]> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'workspace.read');
  return usableModels(ctx, workspaceId);
}

export async function getRoutingPolicy(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
): Promise<RoutingPolicyView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'policy.read');
  const settings = await findRoutingSettings(ctx.db, workspaceId);
  if (settings === undefined) throw new NotFoundError('workspace not found');
  return { settings, routes: (await listRoutes(ctx.db, workspaceId)).map(routeView) };
}

export async function changeRoutingSettings(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
  body: RoutingSettingsBody,
): Promise<RoutingPolicyView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'policy.manage');
  if (body.defaultModel !== null)
    await requireUsable(ctx, workspaceId, body.defaultModel, 'defaultModel');
  if (body.pinnedModel !== null)
    await requireUsable(ctx, workspaceId, body.pinnedModel, 'pinnedModel');
  await updateRoutingSettings(ctx.db, workspaceId, body);
  return getRoutingPolicy(ctx, principal, workspaceId);
}

/**
 * The candidates a save started from (RT-10, ADR 0114). The route and the 'added' decisions are
 * written in one transaction, which first checks each is still offered: if one is not, it throws
 * CandidateGoneError and the route is left as it was. The examples are what the admin saved,
 * edited or not: policy an admin wrote, which outlives the message it came from.
 */
function fromCandidates(principal: Principal, body: RouteBody): FromCandidates | undefined {
  const ids = body.fromCandidates ?? [];
  return ids.length === 0 ? undefined : { messageIds: ids, decidedBy: principal.actingUserId };
}

export async function createRoute(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
  body: RouteBody,
): Promise<RouteView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'policy.manage');
  await validateRoute(ctx, workspaceId, body, null);
  const id = await insertRoute(
    ctx.db,
    workspaceId,
    body,
    principal.actingUserId,
    fromCandidates(principal, body),
  );
  await compileWorkspacePolicy(ctx, workspaceId);
  const created = (await listRoutes(ctx.db, workspaceId)).find((r) => r.id === id);
  if (created === undefined) throw new Error('created route not found');
  return routeView(created);
}

export async function changeRoute(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
  routeId: string,
  body: RouteBody,
): Promise<RouteView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'policy.manage');
  await validateRoute(ctx, workspaceId, body, routeId);
  if (!(await updateRoute(ctx.db, workspaceId, routeId, body, fromCandidates(principal, body)))) {
    throw new NotFoundError('no route with this id');
  }
  await compileWorkspacePolicy(ctx, workspaceId);
  const changed = (await listRoutes(ctx.db, workspaceId)).find((r) => r.id === routeId);
  if (changed === undefined) throw new Error('changed route not found');
  return routeView(changed);
}

export async function removeRoute(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
  routeId: string,
): Promise<void> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'policy.manage');
  if (!(await deleteRoute(ctx.db, workspaceId, routeId)))
    throw new NotFoundError('no route with this id');
}

/**
 * Scores a phrase against the workspace's routes (the admin "try a phrase" tool). The text is
 * used for this call only: never stored or logged. Routes left behind by a model change are
 * recompiled first, which an admin can wait for where a request should not.
 */
export async function tryPhrase(
  ctx: RoutingContext,
  principal: Principal,
  workspaceId: string,
  text: string,
): Promise<TryPhraseResult> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'policy.read');
  let snapshot = await ctx.snapshots.get(workspaceId);
  if (snapshot === undefined) throw new NotFoundError('workspace not found');
  const untrained = snapshot.routes
    .filter((r) => r.enabled && scoringBasis(r) === null)
    .map((r) => r.name);
  let status: TryPhraseResult['status'] = 'too_short';
  let scores: RouteScore[] | undefined;
  // Routes that are off, scored as if on, so the tool can say one came close (Routing board).
  let all: RouteScore[] = [];
  let closestExamples: string[] = [];
  if (worthClassifying(text)) {
    const embedder = await ctx.classifier.embedder();
    if (embedder === undefined) {
      status = 'classifier_unavailable';
    } else {
      if (staleRoutes(snapshot, embedder.modelId).length > 0) {
        await compileWorkspacePolicy(ctx, workspaceId);
        snapshot = (await ctx.snapshots.get(workspaceId)) ?? snapshot;
      }
      status = 'scored';
      const query = await embedder.embed(text);
      scores = scoreRoutes(snapshot, query, embedder.modelId, DEFAULT_MATCH_MODE);
      all = scoreRoutes(
        { ...snapshot, routes: snapshot.routes.map((r) => ({ ...r, enabled: true })) },
        query,
        embedder.modelId,
        DEFAULT_MATCH_MODE,
      );
      const best = scores[0];
      if (best !== undefined) {
        const examples = await listRouteExamples(
          ctx.db,
          workspaceId,
          best.routeId,
          embedder.modelId,
        );
        closestExamples = examples
          .map((e) => ({ text: e.text, similarity: dot(Float32Array.from(e.embedding), query) }))
          .toSorted((a, b) => b.similarity - a.similarity)
          .slice(0, 2)
          .map((e) => e.text);
      }
    }
  }
  const enabled = new Set(snapshot.routes.filter((r) => r.enabled).map((r) => r.id));
  const sources = new Map(snapshot.routes.map((r) => [r.id, r.centroid?.source]));
  const decision = await decisionFor(ctx, snapshot, text, scores);
  return {
    status,
    scores: all.map((s) => {
      // scoreRoutes scores only routes with a centroid from the current model.
      const source = sources.get(s.routeId);
      if (source === undefined) throw new Error('a scored route has no centroid');
      return {
        route: s.name,
        similarity: Math.round(s.similarity * 1e4) / 1e4,
        enabled: enabled.has(s.routeId),
        source,
      };
    }),
    closestExamples,
    untrained,
    decision:
      decision === null
        ? null
        : { ...decision, threshold: await thresholdFor(ctx, snapshot, scores) },
  };
}

/**
 * The lowest confidence the closest enabled route needed (RT-5): the same threshold the
 * resolution order compares against, for the direction its model lies from the default.
 */
async function thresholdFor(
  ctx: RoutingContext,
  policy: PolicySnapshot,
  scores: RouteScore[] | undefined,
): Promise<number | null> {
  const best = scores?.[0];
  const route = best === undefined ? undefined : policy.routes.find((r) => r.id === best.routeId);
  if (route === undefined) return null;
  const direction = await directionOf(route.model, policy.defaultModel, (model) =>
    findModelPrices(ctx, model),
  );
  return direction === 'down' ? route.thresholdDown : route.thresholdUp;
}

/** What a new conversation starting with this phrase would get, through the real resolution order. */
async function decisionFor(
  ctx: RoutingContext,
  policy: PolicySnapshot,
  text: string,
  scores: RouteScore[] | undefined,
): Promise<Omit<TryPhraseDecision, 'threshold'> | null> {
  try {
    const resolution = await resolveRequestModel({
      policy,
      explicitModel: null,
      sticky: null,
      text,
      classify: () => Promise.resolve(scores),
      priceOf: (model) => findModelPrices(ctx, model),
    });
    return {
      rule: resolution.rule,
      model: resolution.model,
      route: policy.routes.find((r) => r.id === resolution.routeId)?.name ?? null,
      signal: resolution.signal,
      confidence:
        resolution.confidence === null ? null : Math.round(resolution.confidence * 1e4) / 1e4,
      reason: resolution.reason,
    };
  } catch (error) {
    if (error instanceof NoModelError) return null;
    throw error;
  }
}
