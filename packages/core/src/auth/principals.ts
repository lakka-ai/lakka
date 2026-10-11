import type { Principal } from '@lakka/contracts';
import { findPrincipalByAuthSubject, insertUserPrincipalIfMissing } from '@lakka/db';
import type { Db, PrincipalRow } from '@lakka/db';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Returns the principal for a Better Auth user, creating it on first use (ID-1). Called only
 * after the Better Auth user is committed, never from inside Better Auth's own transaction, so
 * a principal can never point at a user that was rolled back (ADR 0028).
 */
export async function ensureUserPrincipal(db: Db, user: AuthUser): Promise<PrincipalRow> {
  const existing = await findPrincipalByAuthSubject(db, user.id);
  if (existing !== undefined) return existing;
  await insertUserPrincipalIfMissing(db, {
    authSubject: user.id,
    email: user.email,
    displayName: user.name,
  });
  const created = await findPrincipalByAuthSubject(db, user.id);
  if (created === undefined) throw new Error('principal was not created');
  return created;
}

/** The request-scoped view of a user principal. Keys are built by authenticate. */
export function toPrincipal(row: PrincipalRow): Principal {
  if (row.kind === 'key' && row.ownerPrincipalId === null) {
    // The schema forbids this (principals_key_has_owner_check); refuse rather than guess.
    throw new Error('key principal has no owner');
  }
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    actingUserId:
      row.kind === 'key' && row.ownerPrincipalId !== null ? row.ownerPrincipalId : row.id,
    isInstanceAdmin: row.isInstanceAdmin,
    workspaceScope: null,
  };
}
