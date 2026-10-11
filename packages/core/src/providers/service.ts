import {
  FIRST_PARTY_KINDS,
  ForbiddenError,
  InvalidRequestError,
  isFirstParty,
  NotFoundError,
  ProviderNotConfiguredError,
} from '@lakka/contracts';
import type {
  CreateProviderBody,
  Principal,
  ProviderConfigView,
  ProviderCoverageView,
  ProviderTestResult,
  UpdateProviderBody,
} from '@lakka/contracts';
import {
  deleteProviderConfig,
  findConnection,
  findProviderConfig,
  findProviderSecret,
  insertProviderConfig,
  listProviderConfigs,
  recordProviderTest,
  updateProviderConfig,
} from '@lakka/db';
import type { ProviderConfigRow, ProviderScope, ProviderSecretRow } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import { probeProvider } from '../gateway/probe.ts';
import type { ProviderConnection } from '../gateway/providers.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';

/*
 * Model provider credentials (PR-1, PR-2, PR-3, PR-8, ADR 0038). Instance admins manage
 * instance-wide credentials; workspace admins manage their own workspace's, and those win for
 * that workspace. A workspace credential is limited to a first-party provider at its standard
 * address, so a workspace admin can never make the server connect somewhere inside the
 * customer's network. Keys never appear in a response, a log line or an error.
 */

export interface ProvidersContext extends ServiceContext {
  /** Replaces global fetch for credential tests; tests inject a fake provider here. */
  fetch?: typeof fetch;
}

async function authorize(
  ctx: ProvidersContext,
  principal: Principal,
  scope: ProviderScope,
  write: boolean,
): Promise<void> {
  if (scope === null) {
    if (principal.kind !== 'user' || !principal.isInstanceAdmin) {
      throw new ForbiddenError('only instance admins manage instance-wide provider credentials');
    }
    return;
  }
  await authorizeWorkspaceAction(
    ctx,
    principal,
    scope,
    write ? 'providers.manage' : 'providers.read',
  );
}

function view(row: ProviderConfigRow): ProviderConfigView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    name: row.name,
    baseUrl: row.baseUrl,
    hasKey: row.hasKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastTest:
      row.lastTestedAt === null || row.lastTestStatus === null
        ? null
        : {
            status: row.lastTestStatus,
            httpStatus: row.lastTestHttpStatus,
            testedAt: row.lastTestedAt.toISOString(),
          },
  };
}

function toConnection(row: ProviderSecretRow): ProviderConnection {
  return {
    kind: row.kind,
    name: row.name,
    configId: row.id,
    ...(row.apiKey === null ? {} : { apiKey: row.apiKey }),
    ...(row.baseUrl === null ? {} : { baseURL: row.baseUrl }),
  };
}

export async function listProviders(
  ctx: ProvidersContext,
  principal: Principal,
  scope: ProviderScope,
): Promise<ProviderConfigView[]> {
  await authorize(ctx, principal, scope, false);
  return (await listProviderConfigs(ctx.db, scope)).map(view);
}

const keyed = (rows: readonly ProviderConfigRow[], kind: string) =>
  rows.some((r) => r.kind === kind && r.hasKey);

/**
 * For each first-party provider, whose key the workspace's requests use: a workspace key
 * overrides the instance's (PR-2). Workspace admins may read it; they learn only whether the
 * instance has a key, never anything about it (ADR 0096).
 */
export async function providerCoverage(
  ctx: ProvidersContext,
  principal: Principal,
  workspaceId: string,
): Promise<ProviderCoverageView[]> {
  await authorize(ctx, principal, workspaceId, false);
  const [own, instance] = await Promise.all([
    listProviderConfigs(ctx.db, workspaceId),
    listProviderConfigs(ctx.db, null),
  ]);
  return FIRST_PARTY_KINDS.map((kind) => ({
    kind,
    source: keyed(own, kind) ? 'workspace' : keyed(instance, kind) ? 'instance' : 'none',
    instanceKey: keyed(instance, kind),
  }));
}

export async function addProvider(
  ctx: ProvidersContext,
  principal: Principal,
  scope: ProviderScope,
  body: CreateProviderBody,
): Promise<ProviderConfigView> {
  await authorize(ctx, principal, scope, true);
  if (scope !== null && (!isFirstParty(body.kind) || body.baseUrl !== undefined)) {
    throw new InvalidRequestError(
      'a workspace credential is for a first-party provider at its standard address',
    );
  }
  const row = await insertProviderConfig(ctx.db, scope, {
    kind: body.kind,
    name: body.name ?? body.kind,
    baseUrl: body.baseUrl ?? null,
    apiKey: body.apiKey ?? null,
    createdByPrincipalId: principal.actingUserId,
  });
  return view(row);
}

export async function changeProvider(
  ctx: ProvidersContext,
  principal: Principal,
  scope: ProviderScope,
  id: string,
  body: UpdateProviderBody,
): Promise<ProviderConfigView> {
  await authorize(ctx, principal, scope, true);
  const existing = await findProviderConfig(ctx.db, scope, id);
  if (existing === undefined) throw new NotFoundError('no provider credential with this id');
  if (body.baseUrl !== undefined) {
    if (scope !== null && body.baseUrl !== null) {
      throw new InvalidRequestError('a workspace credential uses the standard address');
    }
    if (existing.kind === 'openai-compatible' && body.baseUrl === null) {
      throw new InvalidRequestError('an OpenAI-compatible endpoint needs an address');
    }
  }
  const row = await updateProviderConfig(ctx.db, scope, id, {
    ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
    ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
  });
  if (row === undefined) throw new NotFoundError('no provider credential with this id');
  return view(row);
}

export async function removeProvider(
  ctx: ProvidersContext,
  principal: Principal,
  scope: ProviderScope,
  id: string,
): Promise<void> {
  await authorize(ctx, principal, scope, true);
  if (!(await deleteProviderConfig(ctx.db, scope, id))) {
    throw new NotFoundError('no provider credential with this id');
  }
}

/** Checks the credential with a free call and records the outcome (PR-1). */
export async function testProvider(
  ctx: ProvidersContext,
  principal: Principal,
  scope: ProviderScope,
  id: string,
): Promise<ProviderTestResult> {
  await authorize(ctx, principal, scope, true);
  const secret = await findProviderSecret(ctx.db, scope, id);
  if (secret === undefined) throw new NotFoundError('no provider credential with this id');
  const result = await probeProvider(
    toConnection(secret),
    ctx.fetch === undefined ? {} : { fetch: ctx.fetch },
  );
  const testedAt = new Date();
  await recordProviderTest(ctx.db, scope, id, { ...result, testedAt });
  return { ...result, testedAt: testedAt.toISOString() };
}

/**
 * The connection a request in `workspaceId` uses for a model whose provider part is `name`: the
 * workspace's own credential if it has one, otherwise the instance's (PR-8).
 */
export async function resolveProviderConnection(
  ctx: Pick<ProvidersContext, 'db'>,
  workspaceId: string,
  name: string,
): Promise<ProviderConnection> {
  const row = await findConnection(ctx.db, workspaceId, name);
  if (row === undefined) {
    throw new ProviderNotConfiguredError('no credential is configured for this provider');
  }
  return toConnection(row);
}
