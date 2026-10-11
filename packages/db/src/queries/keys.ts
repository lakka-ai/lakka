import { aliasedTable, and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { apiKeys, memberships, principals } from '../schema/identity.ts';
import type { PrincipalStatus } from '../schema/identity.ts';

/*
 * API key data access (ID-5, ADR 0030). Listing and revoking are scoped by workspace like all
 * tenant data. Authentication looks a key up by its digest, together with everything needed to
 * decide whether it may act right now, in one query.
 */

const owners = aliasedTable(principals, 'owners');

export interface KeyRow {
  id: string;
  /** The key's own principal. */
  principalId: string;
  name: string;
  prefix: string;
  workspaceId: string;
  ownerPrincipalId: string;
  ownerDisplayName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const keyColumns = {
  id: apiKeys.id,
  principalId: apiKeys.principalId,
  name: principals.displayName,
  prefix: apiKeys.prefix,
  workspaceId: apiKeys.workspaceId,
  ownerPrincipalId: owners.id,
  ownerDisplayName: owners.displayName,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
};

/** Creates the key's principal and its api_keys row together. */
export async function insertKey(
  db: Db,
  workspaceId: string,
  input: { ownerPrincipalId: string; name: string; hash: string; prefix: string },
): Promise<KeyRow> {
  return db.transaction(async (tx) => {
    const [principal] = await tx
      .insert(principals)
      .values({ kind: 'key', displayName: input.name, ownerPrincipalId: input.ownerPrincipalId })
      .returning({ id: principals.id });
    if (principal === undefined) throw new Error('key principal insert returned nothing');
    const [key] = await tx
      .insert(apiKeys)
      .values({ principalId: principal.id, workspaceId, hash: input.hash, prefix: input.prefix })
      .returning({ id: apiKeys.id });
    if (key === undefined) throw new Error('api key insert returned nothing');
    const [row] = await selectKeys(tx).where(
      and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, key.id)),
    );
    if (row === undefined) throw new Error('issued key not found');
    return row;
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Base query for key views. Callers add the full condition, always including the workspace. */
function selectKeys(db: Db | Tx) {
  return db
    .select(keyColumns)
    .from(apiKeys)
    .innerJoin(principals, eq(principals.id, apiKeys.principalId))
    .innerJoin(owners, eq(owners.id, principals.ownerPrincipalId))
    .$dynamic();
}

/** Keys in a workspace, newest first; only one owner's when `ownerPrincipalId` is given. */
export async function listKeys(
  db: Db,
  workspaceId: string,
  ownerPrincipalId?: string,
): Promise<KeyRow[]> {
  return selectKeys(db)
    .where(
      ownerPrincipalId === undefined
        ? eq(apiKeys.workspaceId, workspaceId)
        : and(eq(apiKeys.workspaceId, workspaceId), eq(owners.id, ownerPrincipalId)),
    )
    .orderBy(desc(apiKeys.createdAt));
}

export async function findKey(
  db: Db,
  workspaceId: string,
  keyId: string,
): Promise<KeyRow | undefined> {
  const [row] = await selectKeys(db).where(
    and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, keyId)),
  );
  return row;
}

/** Marks a key revoked. The row stays for audit. Revoking twice keeps the first time. */
export async function revokeKey(db: Db, workspaceId: string, keyId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())` })
    .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, keyId)));
}

export interface KeyAuthRow {
  keyId: string;
  keyPrincipalId: string;
  name: string;
  workspaceId: string;
  revokedAt: Date | null;
  keyStatus: PrincipalStatus;
  ownerPrincipalId: string;
  ownerStatus: PrincipalStatus;
  /** The owner's role in the key's workspace right now, or null if no longer a member. */
  ownerRole: 'admin' | 'member' | null;
}

/** Everything authentication needs about a key, looked up by the digest of its secret. */
export async function findKeyForAuth(db: Db, hash: string): Promise<KeyAuthRow | undefined> {
  const [row] = await db
    .select({
      keyId: apiKeys.id,
      keyPrincipalId: principals.id,
      name: principals.displayName,
      workspaceId: apiKeys.workspaceId,
      revokedAt: apiKeys.revokedAt,
      keyStatus: principals.status,
      ownerPrincipalId: owners.id,
      ownerStatus: owners.status,
      ownerRole: memberships.role,
    })
    .from(apiKeys)
    .innerJoin(principals, eq(principals.id, apiKeys.principalId))
    .innerJoin(owners, eq(owners.id, principals.ownerPrincipalId))
    .leftJoin(
      memberships,
      and(eq(memberships.workspaceId, apiKeys.workspaceId), eq(memberships.principalId, owners.id)),
    )
    .where(eq(apiKeys.hash, hash))
    .limit(1);
  return row;
}

/** Records use, at most once a minute per key, so authentication does not write on every call. */
export async function touchKey(db: Db, keyId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.id, keyId),
        or(isNull(apiKeys.lastUsedAt), sql`${apiKeys.lastUsedAt} < now() - interval '1 minute'`),
      ),
    );
}
