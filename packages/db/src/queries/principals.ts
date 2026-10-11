import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { authAccounts } from '../schema/auth.ts';
import { memberships, principals, workspaces } from '../schema/identity.ts';
import { ssoProviderPolicies } from '../schema/sso.ts';

/*
 * Principal lookups. Principals are instance-wide (a person can be in many workspaces), so
 * these are not workspace-scoped; workspace data goes through scoped helpers.
 */

export type PrincipalRow = typeof principals.$inferSelect;

export async function findPrincipalByAuthSubject(
  db: Db,
  authSubject: string,
): Promise<PrincipalRow | undefined> {
  const [row] = await db
    .select()
    .from(principals)
    .where(eq(principals.authSubject, authSubject))
    .limit(1);
  return row;
}

/** A person's email, or undefined if there is no such person. */
export async function findPrincipalEmail(
  db: Db,
  principalId: string,
): Promise<string | null | undefined> {
  const [row] = await db
    .select({ email: principals.email })
    .from(principals)
    .where(eq(principals.id, principalId))
    .limit(1);
  return row?.email;
}

/** Inserts a user principal unless one already exists for this Better Auth user. */
export async function insertUserPrincipalIfMissing(
  db: Db,
  user: { authSubject: string; email: string; displayName: string },
): Promise<void> {
  await db
    .insert(principals)
    .values({
      kind: 'user',
      displayName: user.displayName,
      email: user.email.toLowerCase(),
      authSubject: user.authSubject,
    })
    .onConflictDoNothing({ target: principals.authSubject });
}

/**
 * Every person on the instance, for instance admins (ID-6). Keys are listed per workspace, and
 * deleted people are gone from the list (NF-P4).
 */
export async function listUserPrincipals(db: Db): Promise<PrincipalRow[]> {
  return db
    .select()
    .from(principals)
    .where(and(eq(principals.kind, 'user'), ne(principals.status, 'deleted')))
    .orderBy(asc(principals.displayName));
}

/**
 * Sets a user's status and returns the row, or undefined if there is no such user. A deleted
 * person is no one to suspend or reactivate (NF-P4).
 */
export async function setUserStatus(
  db: Db,
  principalId: string,
  status: 'active' | 'suspended',
): Promise<PrincipalRow | undefined> {
  const [row] = await db
    .update(principals)
    .set({ status })
    .where(
      and(
        eq(principals.id, principalId),
        eq(principals.kind, 'user'),
        ne(principals.status, 'deleted'),
      ),
    )
    .returning();
  return row;
}

/** Grants or removes instance admin; users only (ADR 0027). */
export async function setInstanceAdmin(
  db: Db,
  principalId: string,
  isInstanceAdmin: boolean,
): Promise<void> {
  await db
    .update(principals)
    .set({ isInstanceAdmin })
    .where(and(eq(principals.id, principalId), eq(principals.kind, 'user')));
}

export type InstanceAdminChange =
  | { outcome: 'changed'; row: PrincipalRow }
  | { outcome: 'not_found' }
  | { outcome: 'last_admin' };

/**
 * Grants or removes instance admin from the People page (ADR 0097). Removing it is refused when
 * no other active instance admin would be left. The admins are locked first, so two admins
 * removing each other at once cannot both succeed.
 */
export async function changeInstanceAdmin(
  db: Db,
  principalId: string,
  isInstanceAdmin: boolean,
): Promise<InstanceAdminChange> {
  return db.transaction(async (tx) => {
    const admins = await tx
      .select({ id: principals.id })
      .from(principals)
      .where(
        and(
          eq(principals.kind, 'user'),
          eq(principals.isInstanceAdmin, true),
          eq(principals.status, 'active'),
        ),
      )
      .for('update');
    if (!isInstanceAdmin && !admins.some((admin) => admin.id !== principalId)) {
      return { outcome: 'last_admin' };
    }
    const [row] = await tx
      .update(principals)
      .set({ isInstanceAdmin })
      .where(
        and(
          eq(principals.id, principalId),
          eq(principals.kind, 'user'),
          ne(principals.status, 'deleted'),
        ),
      )
      .returning();
    return row === undefined ? { outcome: 'not_found' } : { outcome: 'changed', row };
  });
}

/**
 * Marks a person active now, unless they were marked within the last five minutes, so a busy
 * person costs one write every few minutes rather than one per request (ADR 0097).
 */
export async function touchPrincipal(db: Db, principalId: string): Promise<void> {
  await db
    .update(principals)
    .set({ lastActiveAt: sql`now()` })
    .where(
      and(
        eq(principals.id, principalId),
        eq(principals.kind, 'user'),
        or(
          isNull(principals.lastActiveAt),
          sql`${principals.lastActiveAt} < now() - interval '5 minutes'`,
        ),
      ),
    );
}

export interface PersonWorkspaceRow {
  principalId: string;
  workspaceId: string;
  name: string;
  role: 'admin' | 'member';
}

/** The workspaces of the given people, with their role in each. For instance admins only. */
export async function listWorkspacesForPeople(
  db: Db,
  principalIds: readonly string[],
): Promise<PersonWorkspaceRow[]> {
  if (principalIds.length === 0) return [];
  return db
    .select({
      principalId: memberships.principalId,
      workspaceId: workspaces.id,
      name: workspaces.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(inArray(memberships.principalId, [...principalIds]))
    .orderBy(asc(workspaces.name));
}

export interface PersonSignInRow {
  authSubject: string;
  /** Better Auth's provider id: 'credential' for a password, else the SSO provider's id. */
  providerId: string;
  /** The SSO provider's name, or null for a password or a provider since removed. */
  displayName: string | null;
}

/** How each of the given Better Auth users can sign in. */
export async function listSignInsForPeople(
  db: Db,
  authSubjects: readonly string[],
): Promise<PersonSignInRow[]> {
  if (authSubjects.length === 0) return [];
  return db
    .selectDistinct({
      authSubject: authAccounts.userId,
      providerId: authAccounts.providerId,
      displayName: ssoProviderPolicies.displayName,
    })
    .from(authAccounts)
    .leftJoin(ssoProviderPolicies, eq(ssoProviderPolicies.providerId, authAccounts.providerId))
    .where(inArray(authAccounts.userId, [...authSubjects]));
}
