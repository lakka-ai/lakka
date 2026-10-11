import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { LastWorkspaceAdminError, SlugTakenError } from '@lakka/contracts';
import type { Db } from '../client.ts';
import { memberships, principals, workspaces } from '../schema/identity.ts';

/*
 * Workspace data access (ID-3, ID-4). Tenant data is always reached through a workspace id
 * (CLAUDE.md, Code conventions): every function that touches memberships takes the workspace
 * as its first argument and filters on it, so a caller cannot forget the scope. Authorization
 * happens in core before these are called; these only enforce data rules.
 */

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type Role = (typeof memberships.$inferSelect)['role'];

/** The capture setting is read on its own (capture.ts), not with every workspace listing. */
type ListedWorkspace = Omit<
  WorkspaceRow,
  | 'contentCapture'
  | 'contentRetentionDays'
  | 'contentCaptureChangedAt'
  | 'contentCaptureChangedBy'
  | 'deletedAt'
  | 'deletedByPrincipalId'
  | 'purgedAt'
>;

export interface WorkspaceWithRole extends ListedWorkspace {
  role: Role | null;
}

export interface MemberRow {
  principalId: string;
  displayName: string;
  email: string | null;
  role: Role;
  joinedAt: Date;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint' in current &&
      current.constraint === constraint
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Creates a workspace with its first admin in one transaction. */
export async function createWorkspaceWithAdmin(
  db: Db,
  input: { name: string; slug: string },
  adminPrincipalId: string,
): Promise<WorkspaceRow> {
  try {
    return await db.transaction(async (tx) => {
      const [workspace] = await tx.insert(workspaces).values(input).returning();
      if (workspace === undefined) throw new Error('workspace insert returned nothing');
      await tx
        .insert(memberships)
        .values({ workspaceId: workspace.id, principalId: adminPrincipalId, role: 'admin' });
      return workspace;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'workspaces_slug_key')) {
      throw new SlugTakenError('a workspace with this slug already exists', { cause: error });
    }
    throw error;
  }
}

/** Workspaces the principal belongs to, with its role in each. */
export async function listWorkspacesForMember(
  db: Db,
  principalId: string,
): Promise<WorkspaceWithRole[]> {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      defaultModel: workspaces.defaultModel,
      routingEnabled: workspaces.routingEnabled,
      pinnedModel: workspaces.pinnedModel,
      policyVersion: workspaces.policyVersion,
      settings: workspaces.settings,
      createdAt: workspaces.createdAt,
      role: memberships.role,
    })
    .from(workspaces)
    .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
    .where(and(eq(memberships.principalId, principalId), isNull(workspaces.deletedAt)))
    .orderBy(asc(workspaces.name));
}

/** Every workspace, with the principal's role where it has one. For instance admins only. */
export async function listAllWorkspaces(db: Db, principalId: string): Promise<WorkspaceWithRole[]> {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      defaultModel: workspaces.defaultModel,
      routingEnabled: workspaces.routingEnabled,
      pinnedModel: workspaces.pinnedModel,
      policyVersion: workspaces.policyVersion,
      settings: workspaces.settings,
      createdAt: workspaces.createdAt,
      role: memberships.role,
    })
    .from(workspaces)
    .leftJoin(
      memberships,
      and(eq(memberships.workspaceId, workspaces.id), eq(memberships.principalId, principalId)),
    )
    .where(isNull(workspaces.deletedAt))
    .orderBy(asc(workspaces.name));
}

/** A workspace that exists and is not deleted (ID-8): a deleted one answers as missing. */
export async function findWorkspace(
  db: Db,
  workspaceId: string,
): Promise<WorkspaceRow | undefined> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  return row;
}

export async function renameWorkspace(
  db: Db,
  workspaceId: string,
  name: string,
): Promise<WorkspaceRow> {
  const [row] = await db
    .update(workspaces)
    .set({ name })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  if (row === undefined) throw new Error('workspace disappeared during rename');
  return row;
}

export async function findMembership(
  db: Db,
  workspaceId: string,
  principalId: string,
): Promise<{ role: Role } | undefined> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.principalId, principalId)))
    .limit(1);
  return row;
}

/** A person's membership with when they joined, for the invite page (ADR 0098). */
export async function findMembershipSince(
  db: Db,
  workspaceId: string,
  principalId: string,
): Promise<{ role: Role; createdAt: Date } | undefined> {
  const [row] = await db
    .select({ role: memberships.role, createdAt: memberships.createdAt })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.principalId, principalId)))
    .limit(1);
  return row;
}

export async function listMembers(db: Db, workspaceId: string): Promise<MemberRow[]> {
  return db
    .select({
      principalId: memberships.principalId,
      displayName: principals.displayName,
      email: principals.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(principals, eq(principals.id, memberships.principalId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(principals.displayName));
}

/**
 * Adds a member or changes a role. Refuses to demote the last admin. The workspace row is
 * locked for the duration, so two admins demoting each other at once cannot both succeed.
 */
export async function setMemberRole(
  db: Db,
  workspaceId: string,
  principalId: string,
  role: Role,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    if (role !== 'admin') await ensureAnotherAdmin(tx, workspaceId, principalId);
    await tx
      .insert(memberships)
      .values({ workspaceId, principalId, role })
      .onConflictDoUpdate({
        target: [memberships.workspaceId, memberships.principalId],
        set: { role },
      });
  });
}

/** Removes a member. Refuses to remove the last admin. Returns false if there was no such member. */
export async function removeMember(
  db: Db,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await ensureAnotherAdmin(tx, workspaceId, principalId);
    const removed = await tx
      .delete(memberships)
      .where(
        and(eq(memberships.workspaceId, workspaceId), eq(memberships.principalId, principalId)),
      )
      .returning({ principalId: memberships.principalId });
    return removed.length > 0;
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`select 1 from ${workspaces} where ${workspaces.id} = ${workspaceId} for update`,
  );
}

/** Throws if `principalId` is an admin and no other admin would remain. */
async function ensureAnotherAdmin(tx: Tx, workspaceId: string, principalId: string): Promise<void> {
  const [current] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.principalId, principalId)));
  if (current?.role !== 'admin') return;
  const [others] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.role, 'admin'),
        sql`${memberships.principalId} <> ${principalId}`,
      ),
    );
  if ((others?.n ?? 0) === 0) {
    throw new LastWorkspaceAdminError('a workspace must keep at least one admin');
  }
}

/** A user principal that exists and is active, for adding as a member. */
export async function findActiveUser(
  db: Db,
  principalId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: principals.id })
    .from(principals)
    .where(
      and(
        eq(principals.id, principalId),
        eq(principals.kind, 'user'),
        eq(principals.status, 'active'),
      ),
    )
    .limit(1);
  return row;
}
