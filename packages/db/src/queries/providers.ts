import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { ProviderExistsError } from '@lakka/contracts';
import type { ProviderKind, ProviderTestResult } from '@lakka/contracts';
import type { Db } from '../client.ts';
import { providerConfigs } from '../schema/providers.ts';

/*
 * Provider credential data access (PR-1, PR-8, ADR 0038). Every function takes the scope first:
 * a workspace id, or null for instance-wide credentials, and filters on it, so a workspace can
 * never read or change another scope's rows. Views never select the key itself; only
 * findConnection decrypts it, for a request that is about to use it.
 */

export type ProviderScope = string | null;

export interface ProviderConfigRow {
  id: string;
  workspaceId: string | null;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  hasKey: boolean;
  lastTestedAt: Date | null;
  lastTestStatus: ProviderTestResult['status'] | null;
  lastTestHttpStatus: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const viewColumns = {
  id: providerConfigs.id,
  workspaceId: providerConfigs.workspaceId,
  kind: providerConfigs.kind,
  name: providerConfigs.name,
  baseUrl: providerConfigs.baseUrl,
  hasKey: sql<boolean>`${providerConfigs.apiKey} is not null`,
  lastTestedAt: providerConfigs.lastTestedAt,
  lastTestStatus: providerConfigs.lastTestStatus,
  lastTestHttpStatus: providerConfigs.lastTestHttpStatus,
  createdAt: providerConfigs.createdAt,
  updatedAt: providerConfigs.updatedAt,
};

function inScope(scope: ProviderScope): SQL {
  return scope === null
    ? isNull(providerConfigs.workspaceId)
    : eq(providerConfigs.workspaceId, scope);
}

function isNameTaken(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint' in current &&
      current.constraint === 'provider_configs_scope_name_key'
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export async function listProviderConfigs(
  db: Db,
  scope: ProviderScope,
): Promise<ProviderConfigRow[]> {
  return db
    .select(viewColumns)
    .from(providerConfigs)
    .where(inScope(scope))
    .orderBy(asc(providerConfigs.name));
}

export async function findProviderConfig(
  db: Db,
  scope: ProviderScope,
  id: string,
): Promise<ProviderConfigRow | undefined> {
  const [row] = await db
    .select(viewColumns)
    .from(providerConfigs)
    .where(and(inScope(scope), eq(providerConfigs.id, id)))
    .limit(1);
  return row;
}

export async function insertProviderConfig(
  db: Db,
  scope: ProviderScope,
  input: {
    kind: ProviderKind;
    name: string;
    baseUrl: string | null;
    apiKey: string | null;
    createdByPrincipalId: string;
  },
): Promise<ProviderConfigRow> {
  try {
    const [inserted] = await db
      .insert(providerConfigs)
      .values({ ...input, workspaceId: scope })
      .returning({ id: providerConfigs.id });
    if (inserted === undefined) throw new Error('provider insert returned nothing');
    const row = await findProviderConfig(db, scope, inserted.id);
    if (row === undefined) throw new Error('created provider not found');
    return row;
  } catch (error) {
    if (isNameTaken(error)) {
      throw new ProviderExistsError('a credential with this name already exists here', {
        cause: error,
      });
    }
    throw error;
  }
}

/** Replaces the key and/or address. A changed credential needs testing again. */
export async function updateProviderConfig(
  db: Db,
  scope: ProviderScope,
  id: string,
  input: { apiKey?: string; baseUrl?: string | null },
): Promise<ProviderConfigRow | undefined> {
  const rows = await db
    .update(providerConfigs)
    .set({
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestHttpStatus: null,
      updatedAt: sql`now()`,
    })
    .where(and(inScope(scope), eq(providerConfigs.id, id)))
    .returning({ id: providerConfigs.id });
  return rows.length === 0 ? undefined : findProviderConfig(db, scope, id);
}

export async function deleteProviderConfig(
  db: Db,
  scope: ProviderScope,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(providerConfigs)
    .where(and(inScope(scope), eq(providerConfigs.id, id)))
    .returning({ id: providerConfigs.id });
  return rows.length > 0;
}

export async function recordProviderTest(
  db: Db,
  scope: ProviderScope,
  id: string,
  result: { status: ProviderTestResult['status']; httpStatus: number | null; testedAt: Date },
): Promise<void> {
  await db
    .update(providerConfigs)
    .set({
      lastTestedAt: result.testedAt,
      lastTestStatus: result.status,
      lastTestHttpStatus: result.httpStatus,
    })
    .where(and(inScope(scope), eq(providerConfigs.id, id)));
}

export interface ProviderSecretRow {
  id: string;
  workspaceId: string | null;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  /** Decrypted. Keep it in memory only for the request that uses it. */
  apiKey: string | null;
}

const secretColumns = {
  id: providerConfigs.id,
  workspaceId: providerConfigs.workspaceId,
  kind: providerConfigs.kind,
  name: providerConfigs.name,
  baseUrl: providerConfigs.baseUrl,
  apiKey: providerConfigs.apiKey,
};

/** One credential with its key, by id within a scope, for testing it. */
export async function findProviderSecret(
  db: Db,
  scope: ProviderScope,
  id: string,
): Promise<ProviderSecretRow | undefined> {
  const [row] = await db
    .select(secretColumns)
    .from(providerConfigs)
    .where(and(inScope(scope), eq(providerConfigs.id, id)))
    .limit(1);
  return row;
}

/** Every credential in a scope with its key, for the health check's probes (AD-5, ADR 0081). */
export async function listProviderSecrets(
  db: Db,
  scope: ProviderScope,
): Promise<(ProviderSecretRow & { updatedAt: Date })[]> {
  return db
    .select({ ...secretColumns, updatedAt: providerConfigs.updatedAt })
    .from(providerConfigs)
    .where(inScope(scope))
    .orderBy(providerConfigs.name);
}

/**
 * The credential a request in `workspaceId` uses for provider `name`: the workspace's own if it
 * has one, otherwise the instance's (PR-8).
 */
export async function findConnection(
  db: Db,
  workspaceId: string,
  name: string,
): Promise<ProviderSecretRow | undefined> {
  const [row] = await db
    .select(secretColumns)
    .from(providerConfigs)
    .where(
      and(
        eq(providerConfigs.name, name),
        or(eq(providerConfigs.workspaceId, workspaceId), isNull(providerConfigs.workspaceId)),
      ),
    )
    .orderBy(sql`${providerConfigs.workspaceId} is null`)
    .limit(1);
  return row;
}
