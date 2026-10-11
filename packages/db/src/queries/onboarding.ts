import { aliasedTable, and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  AlreadyMemberError,
  InviteInvalidError,
  SetupCompleteError,
  SlugTakenError,
} from '@lakka/contracts';
import type { Db } from '../client.ts';
import { memberships, principals, workspaces } from '../schema/identity.ts';
import type { PrincipalStatus } from '../schema/identity.ts';
import { instanceSetup, invites } from '../schema/onboarding.ts';
import type { PrincipalRow } from './principals.ts';
import type { Role, WorkspaceRow } from './workspaces.ts';

/*
 * First-run setup (AD-1, ADR 0034) and invites (ID-7, ADR 0035). Each operation that creates a
 * person's access runs in one transaction, so a failure leaves nothing half-made. Invites are
 * tenant data: listing and revoking are scoped by workspace. Accepting looks an invite up by its
 * token digest, like key authentication, because the token is the only thing the caller has.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A Better Auth user that has been committed and needs its principal. */
export interface NewAuthUser {
  id: string;
  email: string;
  name: string;
}

function hasPgError(error: unknown, code: string, constraint: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      'code' in current &&
      current.code === code &&
      'constraint' in current &&
      current.constraint === constraint
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function insertUserPrincipal(
  tx: Tx,
  user: NewAuthUser,
  isInstanceAdmin: boolean,
): Promise<PrincipalRow> {
  const [row] = await tx
    .insert(principals)
    .values({
      kind: 'user',
      displayName: user.name,
      email: user.email.toLowerCase(),
      authSubject: user.id,
      isInstanceAdmin,
    })
    .returning();
  if (row === undefined) throw new Error('principal insert returned nothing');
  return row;
}

export async function isSetupComplete(db: Db): Promise<boolean> {
  const rows = await db.select({ id: instanceSetup.id }).from(instanceSetup).limit(1);
  return rows.length > 0;
}

/**
 * Records first-run setup: the first instance admin, the first workspace with that person as
 * its admin, and the setup row, all or nothing. Throws SetupCompleteError if setup already
 * happened, including when another setup commits first while this one runs.
 */
export async function completeSetup(
  db: Db,
  input: { admin: NewAuthUser; workspace: { name: string; slug: string } },
): Promise<{ principal: PrincipalRow; workspace: WorkspaceRow }> {
  try {
    return await db.transaction(async (tx) => {
      const principal = await insertUserPrincipal(tx, input.admin, true);
      // Inserted before the workspace, so a losing concurrent setup stops here.
      await tx.insert(instanceSetup).values({ completedByPrincipalId: principal.id });
      const [workspace] = await tx.insert(workspaces).values(input.workspace).returning();
      if (workspace === undefined) throw new Error('workspace insert returned nothing');
      await tx
        .insert(memberships)
        .values({ workspaceId: workspace.id, principalId: principal.id, role: 'admin' });
      return { principal, workspace };
    });
  } catch (error) {
    if (hasPgError(error, '23505', 'instance_setup_pkey')) {
      throw new SetupCompleteError('setup has already been completed', { cause: error });
    }
    if (hasPgError(error, '23505', 'workspaces_slug_key')) {
      throw new SlugTakenError('a workspace with this slug already exists', { cause: error });
    }
    throw error;
  }
}

export type InviteRow = typeof invites.$inferSelect;

export interface InviteListRow {
  id: string;
  workspaceId: string;
  role: Role;
  createdByPrincipalId: string;
  createdByDisplayName: string;
  createdAt: Date;
  expiresAt: Date;
}

const creators = aliasedTable(principals, 'creators');

const inviteListColumns = {
  id: invites.id,
  workspaceId: invites.workspaceId,
  role: invites.role,
  createdByPrincipalId: invites.createdByPrincipalId,
  createdByDisplayName: creators.displayName,
  createdAt: invites.createdAt,
  expiresAt: invites.expiresAt,
};

export async function insertInvite(
  db: Db,
  workspaceId: string,
  input: { role: Role; tokenHash: string; createdByPrincipalId: string; expiresAt: Date },
): Promise<InviteListRow> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(invites)
      .values({ workspaceId, ...input })
      .returning({ id: invites.id });
    if (inserted === undefined) throw new Error('invite insert returned nothing');
    const [row] = await tx
      .select(inviteListColumns)
      .from(invites)
      .innerJoin(creators, eq(creators.id, invites.createdByPrincipalId))
      .where(and(eq(invites.workspaceId, workspaceId), eq(invites.id, inserted.id)));
    if (row === undefined) throw new Error('created invite not found');
    return row;
  });
}

/** Invites in a workspace that could still be accepted, oldest first. */
export async function listPendingInvites(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<InviteListRow[]> {
  return db
    .select(inviteListColumns)
    .from(invites)
    .innerJoin(creators, eq(creators.id, invites.createdByPrincipalId))
    .where(
      and(
        eq(invites.workspaceId, workspaceId),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .orderBy(asc(invites.createdAt));
}

/** Revokes an unused invite. Returns false if there was no such pending invite. */
export async function revokeInvite(
  db: Db,
  workspaceId: string,
  inviteId: string,
): Promise<boolean> {
  const rows = await db
    .update(invites)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(invites.workspaceId, workspaceId),
        eq(invites.id, inviteId),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
      ),
    )
    .returning({ id: invites.id });
  return rows.length > 0;
}

/** Everything needed to decide whether an invite can be used right now. */
export interface InviteLookupRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  creatorStatus: PrincipalStatus;
  /** Who made it, for "Maja Lind invited you". */
  creatorName: string;
  creatorIsInstanceAdmin: boolean;
  /** The creator's current role in the invite's workspace, or null if they left it. */
  creatorRole: Role | null;
}

function selectInviteLookup(db: Db | Tx) {
  return db
    .select({
      id: invites.id,
      workspaceId: invites.workspaceId,
      workspaceName: workspaces.name,
      role: invites.role,
      expiresAt: invites.expiresAt,
      acceptedAt: invites.acceptedAt,
      revokedAt: invites.revokedAt,
      creatorStatus: creators.status,
      creatorName: creators.displayName,
      creatorIsInstanceAdmin: creators.isInstanceAdmin,
      creatorRole: memberships.role,
    })
    .from(invites)
    .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
    .innerJoin(creators, eq(creators.id, invites.createdByPrincipalId))
    .leftJoin(
      memberships,
      and(
        eq(memberships.workspaceId, invites.workspaceId),
        eq(memberships.principalId, invites.createdByPrincipalId),
      ),
    )
    .$dynamic();
}

export async function findInviteByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<InviteLookupRow | undefined> {
  const [row] = await selectInviteLookup(db).where(eq(invites.tokenHash, tokenHash)).limit(1);
  return row;
}

/** Who is accepting: someone who already has a principal, or a just-created local account. */
export type Invitee = { principalId: string } | { newUser: NewAuthUser };

/**
 * Accepts an invite in one transaction: locks the invite row, asks `isUsable` whether it may
 * still be used (the rule lives in core), creates the principal for a new account, adds the
 * membership and marks the invite used. Two people accepting the same link at once cannot both
 * succeed. Throws InviteInvalidError or AlreadyMemberError, leaving everything unchanged.
 */
export async function acceptInvite(
  db: Db,
  tokenHash: string,
  invitee: Invitee,
  isUsable: (invite: InviteLookupRow) => boolean,
): Promise<{ workspaceId: string; principalId: string }> {
  return db.transaction(async (tx) => {
    const [invite] = await selectInviteLookup(tx)
      .where(eq(invites.tokenHash, tokenHash))
      .for('update', { of: invites });
    if (invite === undefined || !isUsable(invite)) {
      throw new InviteInvalidError('this invite cannot be used');
    }
    const principalId =
      'principalId' in invitee
        ? invitee.principalId
        : (await insertUserPrincipal(tx, invitee.newUser, false)).id;
    const [existing] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, invite.workspaceId),
          eq(memberships.principalId, principalId),
        ),
      );
    if (existing !== undefined) {
      throw new AlreadyMemberError('already a member of this workspace');
    }
    await tx
      .insert(memberships)
      .values({ workspaceId: invite.workspaceId, principalId, role: invite.role });
    await tx
      .update(invites)
      .set({ acceptedAt: sql`now()`, acceptedByPrincipalId: principalId })
      .where(and(eq(invites.workspaceId, invite.workspaceId), eq(invites.id, invite.id)));
    return { workspaceId: invite.workspaceId, principalId };
  });
}
