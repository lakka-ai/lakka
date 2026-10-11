import { createHash, randomBytes } from 'node:crypto';
import { ForbiddenError, InviteInvalidError, NotFoundError } from '@lakka/contracts';
import type {
  AcceptedInvite,
  CreatedInvite,
  InvitePreview,
  InviteView,
  NewAccount,
  Principal,
  WorkspaceRole,
} from '@lakka/contracts';
import {
  acceptInvite,
  deleteAuthUser,
  findInviteByTokenHash,
  findMembershipSince,
  insertInvite,
  listPendingInvites,
  revokeInvite,
} from '@lakka/db';
import type { Db, InviteListRow, InviteLookupRow } from '@lakka/db';
import type { Auth } from '../auth/auth.ts';
import { createAuthAccount } from '../auth/local-users.ts';
import type { ServiceContext } from '../context.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';

/*
 * Invite links (ID-7, ADR 0035). A workspace admin creates a link for one person and shares it
 * however they like; accepting it adds that person to the workspace with the chosen role. The
 * link works once, for a limited time, and only while the person who made it could still make
 * it: an invite is a delegation of its creator, like a key (invariant 2).
 */

export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Whether an invite may be accepted now: unused, not revoked, not expired, and its creator is
 * active and still an admin of the workspace (or an instance admin).
 */
export function inviteUsable(invite: InviteLookupRow, now: Date): boolean {
  return (
    invite.acceptedAt === null &&
    invite.revokedAt === null &&
    invite.expiresAt.getTime() > now.getTime() &&
    invite.creatorStatus === 'active' &&
    (invite.creatorIsInstanceAdmin || invite.creatorRole === 'admin')
  );
}

function view(row: InviteListRow): InviteView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    role: row.role,
    createdBy: { principalId: row.createdByPrincipalId, displayName: row.createdByDisplayName },
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function createInvite(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  input: { role: WorkspaceRole },
  now: Date = new Date(),
): Promise<CreatedInvite> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'invites.create');
  const { token, hash } = generateInviteToken();
  const row = await insertInvite(ctx.db, workspaceId, {
    role: input.role,
    tokenHash: hash,
    createdByPrincipalId: principal.actingUserId,
    expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
  });
  return { invite: view(row), token };
}

export async function listWorkspaceInvites(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
): Promise<InviteView[]> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'invites.list');
  return (await listPendingInvites(ctx.db, workspaceId, new Date())).map(view);
}

export async function revokeWorkspaceInvite(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  inviteId: string,
): Promise<void> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'invites.revoke');
  if (!(await revokeInvite(ctx.db, workspaceId, inviteId))) {
    throw new NotFoundError('no pending invite with this id');
  }
}

async function usableInvite(db: Db, token: string): Promise<InviteLookupRow> {
  const invite = await findInviteByTokenHash(db, hashInviteToken(token));
  if (invite === undefined || !inviteUsable(invite, new Date())) {
    throw new InviteInvalidError('this invite cannot be used');
  }
  return invite;
}

/**
 * What the holder of a usable link sees before accepting: the workspace, the role and who made
 * the link. A signed-in person also learns whether they are in the workspace already, and since
 * when (ADR 0098).
 */
export async function previewInvite(
  ctx: { db: Db },
  token: string,
  principal: Principal | null = null,
): Promise<InvitePreview> {
  const invite = await usableInvite(ctx.db, token);
  const membership =
    principal?.kind === 'user'
      ? await findMembershipSince(ctx.db, invite.workspaceId, principal.actingUserId)
      : undefined;
  return {
    workspaceName: invite.workspaceName,
    role: invite.role,
    expiresAt: invite.expiresAt.toISOString(),
    invitedBy: invite.creatorName,
    alreadyMember:
      membership === undefined
        ? null
        : {
            workspaceId: invite.workspaceId,
            role: membership.role,
            joinedAt: membership.createdAt.toISOString(),
          },
  };
}

/**
 * Joins the workspace as the signed-in person. A key cannot accept invites: that would let a
 * leaked key add its owner to other workspaces.
 */
export async function acceptInviteAsPrincipal(
  ctx: { db: Db },
  principal: Principal,
  token: string,
): Promise<AcceptedInvite> {
  if (principal.kind !== 'user') throw new ForbiddenError('only people can accept invites');
  const { workspaceId } = await acceptInvite(
    ctx.db,
    hashInviteToken(token),
    { principalId: principal.actingUserId },
    (invite) => inviteUsable(invite, new Date()),
  );
  return { workspaceId };
}

/**
 * Creates a local account, joins the workspace with it, and returns cookies that sign the new
 * person in. The invite is checked before the account is created, and again under a row lock
 * when joining; if joining fails, the new account and its session are removed so nothing is
 * left without the access it was created for.
 */
export async function acceptInviteWithNewAccount(
  ctx: { auth: Auth; db: Db },
  token: string,
  account: NewAccount,
): Promise<AcceptedInvite & { principalId: string; sessionCookies: string[] }> {
  await usableInvite(ctx.db, token);
  const { user, sessionCookies } = await createAuthAccount(ctx, account, { signIn: true });
  try {
    const accepted = await acceptInvite(
      ctx.db,
      hashInviteToken(token),
      { newUser: user },
      (invite) => inviteUsable(invite, new Date()),
    );
    return { ...accepted, sessionCookies };
  } catch (error) {
    await deleteAuthUser(ctx.db, user.id);
    throw error;
  }
}
