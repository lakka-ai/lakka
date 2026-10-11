import {
  InvalidRequestError,
  modelDisplayName,
  NotFoundError,
  parseModelRef,
} from '@lakka/contracts';
import type { InputSupport, ModelView, Principal, RequestableView } from '@lakka/contracts';
import { listWorkspacesForMember } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import type { CatalogueStore } from '../models/catalogue.ts';
import { usableModels } from '../routing/policy-service.ts';
import type { PolicySnapshots } from '../routing/snapshot.ts';
import type { PolicySnapshot } from '../routing/score.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';
import type { PipelineContext } from './handle.ts';

type RequestableContext = ServiceContext & {
  catalogue: CatalogueStore;
  snapshots: PolicySnapshots;
};

/*
 * What a caller may ask for, and where (API-2, G1, ADR 0059): the routes it can name, and the
 * models the workspace can call (priced, with a credential). The same list whatever the
 * surface.
 */

export interface RequestableModels {
  /** Enabled routes, by name. */
  routes: string[];
  models: ModelView[];
}

async function requestable(
  ctx: RequestableContext,
  principal: Principal,
  workspaceId: string,
): Promise<{ policy: PolicySnapshot; models: ModelView[] }> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'models.use');
  const policy = await ctx.snapshots.get(workspaceId);
  if (policy === undefined) throw new NotFoundError('workspace not found');
  return { policy, models: await usableModels(ctx, workspaceId) };
}

export async function listRequestableModels(
  ctx: RequestableContext,
  principal: Principal,
  workspaceId: string,
): Promise<RequestableModels> {
  const { policy, models } = await requestable(ctx, principal, workspaceId);
  return { routes: policy.routes.filter((r) => r.enabled).map((r) => r.name), models };
}

/**
 * The same list with what each choice can read (CH-5, ADR 0062). Dispatch passes over a model
 * that cannot read a request's files and tries the next candidate, so a route reads a kind of
 * file when any of its models does. "auto" reads it when any model it could pick does: the pinned
 * model if there is one, otherwise the default and, with routing on, every enabled route. A
 * conversation's earlier routing decision is not known here, so "auto" can still be refused.
 */
export async function describeRequestable(
  ctx: RequestableContext,
  principal: Principal,
  workspaceId: string,
): Promise<RequestableView> {
  const { policy, models } = await requestable(ctx, principal, workspaceId);
  const byId = new Map(models.map((m) => [m.id, m]));
  const support = (refs: readonly (string | null)[]): InputSupport => {
    const usable = refs.flatMap((ref) => {
      const model = ref === null ? undefined : byId.get(ref);
      return model === undefined ? [] : [model];
    });
    return {
      images: usable.some((m) => m.capabilities.vision),
      pdf: usable.some((m) => m.capabilities.pdf),
    };
  };
  const routes = policy.routes.filter((r) => r.enabled);
  const autoRefs =
    policy.pinnedModel !== null
      ? [policy.pinnedModel]
      : [
          policy.defaultModel,
          ...(policy.routingEnabled ? routes.flatMap((r) => [r.model, ...r.fallbacks]) : []),
        ];
  // A model the workspace cannot call any more still gets a readable name.
  const nameOf = (ref: string) =>
    byId.get(ref)?.displayName ?? modelDisplayName(parseModelRef(ref)?.model ?? ref);
  const named = (ref: string | null) => (ref === null ? null : { id: ref, name: nameOf(ref) });
  return {
    auto: support(autoRefs),
    routes: routes.map((r) => ({
      name: r.name,
      model: r.model,
      modelName: nameOf(r.model),
      input: support([r.model, ...r.fallbacks]),
    })),
    models: models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      input: support([m.id]),
    })),
    routing: {
      enabled: policy.routingEnabled,
      defaultModel: named(policy.defaultModel),
      pinnedModel: named(policy.pinnedModel),
    },
  };
}

/**
 * The workspace a request acts in when it does not say: a key's own, or a person's only
 * workspace. Someone in several must name one.
 */
export async function defaultWorkspaceFor(
  ctx: PipelineContext,
  principal: Principal,
): Promise<string> {
  if (principal.kind === 'key' && principal.workspaceScope !== null)
    return principal.workspaceScope;
  const workspaces = await listWorkspacesForMember(ctx.db, principal.actingUserId);
  const [only] = workspaces;
  if (only === undefined) throw new NotFoundError('you are not a member of any workspace');
  if (workspaces.length > 1) {
    throw new InvalidRequestError(
      'you belong to several workspaces: name one in the x-lakka-workspace header',
    );
  }
  return only.id;
}
