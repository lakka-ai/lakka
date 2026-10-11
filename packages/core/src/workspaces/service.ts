import { ConfirmationMismatchError, ForbiddenError, NotFoundError } from '@lakka/contracts';
import type {
  CreateWorkspaceInput,
  DeleteWorkspaceBody,
  MemberView,
  Principal,
  WorkspaceRole,
  WorkspaceView,
} from '@lakka/contracts';
import {
  createWorkspaceWithAdmin,
  deleteUserMcpCredentialsInWorkspace,
  findActiveUser,
  findMembership,
  findWorkspace,
  listAllWorkspaces,
  listMembers,
  listWorkspacesForMember,
  removeMember,
  renameWorkspace,
  setMemberRole,
  tombstoneWorkspace,
} from '@lakka/db';
import type { MemberRow, WorkspaceRow } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import { decide, mayCreateWorkspace } from '../authz/policy.ts';
import type { WorkspaceAction } from '../authz/policy.ts';

/*
 * Workspace and membership operations (ID-3, ID-4). Every surface calls these functions; none
 * talk to the database directly (CLAUDE.md invariant 1). Each one authorizes first, as the
 * acting user (NF-S2), then calls a workspace-scoped query.
 */

export type WorkspaceContext = ServiceContext;

const hidden = () => new NotFoundError('workspace not found');

/** Loads the workspace and checks the action, or throws NotFoundError / ForbiddenError. */
export async function authorizeWorkspaceAction(
  ctx: WorkspaceContext,
  principal: Principal,
  workspaceId: string,
  action: WorkspaceAction,
  targetPrincipalId?: string,
): Promise<{ workspace: WorkspaceRow; role: WorkspaceRole | null }> {
  const workspace = await findWorkspace(ctx.db, workspaceId);
  if (workspace === undefined) throw hidden();
  const membership = await findMembership(ctx.db, workspaceId, principal.actingUserId);
  const role = membership?.role ?? null;
  const decision = decide({
    principal,
    action,
    role,
    workspaceId,
    ...(targetPrincipalId === undefined ? {} : { targetPrincipalId }),
  });
  if (decision === 'hidden') throw hidden();
  if (decision === 'deny') throw new ForbiddenError('your role does not allow this');
  return { workspace, role };
}

function view(
  row: Pick<WorkspaceRow, 'id' | 'name' | 'slug' | 'createdAt'>,
  role: WorkspaceRole | null,
): WorkspaceView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role,
    createdAt: row.createdAt.toISOString(),
  };
}

function memberView(row: MemberRow): MemberView {
  return {
    principalId: row.principalId,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
  };
}

/**
 * The first admin is the caller unless they name someone else, who must be an active user, as
 * when an instance admin adds a member (ADR 0102). The caller then sees the new workspace only
 * as an instance admin.
 */
export async function createWorkspace(
  ctx: WorkspaceContext,
  principal: Principal,
  input: CreateWorkspaceInput,
): Promise<WorkspaceView> {
  if (!mayCreateWorkspace(principal))
    throw new ForbiddenError('only instance admins create workspaces');
  const adminId = input.adminPrincipalId ?? principal.actingUserId;
  if (adminId !== principal.actingUserId && (await findActiveUser(ctx.db, adminId)) === undefined) {
    throw new NotFoundError('no active user with this id');
  }
  const row = await createWorkspaceWithAdmin(
    ctx.db,
    { name: input.name, slug: input.slug },
    adminId,
  );
  return view(row, adminId === principal.actingUserId ? 'admin' : null);
}

export async function listWorkspaces(
  ctx: WorkspaceContext,
  principal: Principal,
): Promise<WorkspaceView[]> {
  const rows =
    principal.isInstanceAdmin && principal.kind === 'user'
      ? await listAllWorkspaces(ctx.db, principal.actingUserId)
      : await listWorkspacesForMember(ctx.db, principal.actingUserId);
  // A key sees only the workspace it is scoped to (ID-5).
  const visible =
    principal.kind === 'key' ? rows.filter((r) => r.id === principal.workspaceScope) : rows;
  return visible.map((row) => view(row, row.role));
}

export async function getWorkspace(
  ctx: WorkspaceContext,
  principal: Principal,
  workspaceId: string,
): Promise<WorkspaceView> {
  const { workspace, role } = await authorizeWorkspaceAction(
    ctx,
    principal,
    workspaceId,
    'workspace.read',
  );
  return view(workspace, role);
}

export async function updateWorkspace(
  ctx: WorkspaceContext,
  principal: Principal,
  workspaceId: string,
  input: { name: string },
): Promise<WorkspaceView> {
  const { role } = await authorizeWorkspaceAction(ctx, principal, workspaceId, 'workspace.update');
  return view(await renameWorkspace(ctx.db, workspaceId, input.name), role);
}

/**
 * Deletes a workspace (ID-8, ADR 0104), for instance admins only. The caller types its current
 * name again, so a wrong id cannot delete another one. Access ends at once: its people lose
 * their membership, its keys are revoked and its credentials go, and their open requests end.
 * What it held is removed afterwards by the purge job; what records its spend stays.
 */
export async function deleteWorkspace(
  ctx: WorkspaceContext,
  principal: Principal,
  workspaceId: string,
  body: DeleteWorkspaceBody,
): Promise<{ memberIds: string[]; keyPrincipalIds: string[] }> {
  if (!mayCreateWorkspace(principal)) {
    throw new ForbiddenError('only instance admins delete workspaces');
  }
  const workspace = await findWorkspace(ctx.db, workspaceId);
  if (workspace === undefined) throw hidden();
  if (body.confirmName.trim() !== workspace.name) {
    throw new ConfirmationMismatchError("confirmName: does not match the workspace's name");
  }
  const deleted = await tombstoneWorkspace(ctx.db, workspaceId, principal.actingUserId);
  // Deleted by someone else since it was read.
  if (deleted === undefined) throw hidden();
  // Memberships are gone, so live requests also end on their next recheck if an event is lost.
  for (const principalId of [...deleted.memberIds, ...deleted.keyPrincipalIds]) {
    await ctx.events.principalRevoked({ principalId, reason: 'workspace_deleted', workspaceId });
  }
  return deleted;
}

export async function listWorkspaceMembers(
  ctx: WorkspaceContext,
  principal: Principal,
  workspaceId: string,
): Promise<MemberView[]> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'members.read');
  return (await listMembers(ctx.db, workspaceId)).map(memberView);
}

/**
 * Adds a member or changes a role. Changing an existing member's role needs workspace admin;
 * adding someone new needs instance admin, because workspace admins invite people (ADR 0035)
 * rather than pull arbitrary users in by id (ADR 0029).
 */
export async function setWorkspaceMember(
  ctx: WorkspaceContext,
  principal: Principal,
  workspaceId: string,
  targetPrincipalId: string,
  role: WorkspaceRole,
): Promise<MemberView[]> {
  const existing = await findMembership(ctx.db, workspaceId, targetPrincipalId);
  const action: WorkspaceAction = existing === undefined ? 'members.add' : 'members.change_role';
  await authorizeWorkspaceAction(ctx, principal, workspaceId, action, targetPrincipalId);
  if (existing === undefined && (await findActiveUser(ctx.db, targetPrincipalId)) === undefined) {
    throw new NotFoundError('no active user with this id');
  }
  await setMemberRole(ctx.db, workspaceId, targetPrincipalId, role);
  return (await listMembers(ctx.db, workspaceId)).map(memberView);
}

export async function removeWorkspaceMember(
  ctx: WorkspaceContext,
  principal: Principal,
  workspaceId: string,
  targetPrincipalId: string,
): Promise<void> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'members.remove', targetPrincipalId);
  if (!(await removeMember(ctx.db, workspaceId, targetPrincipalId))) {
    throw new NotFoundError('not a member of this workspace');
  }
  // Their own tokens for this workspace's MCP servers go with them (TL-2, ADR 0068).
  await deleteUserMcpCredentialsInWorkspace(ctx.db, workspaceId, targetPrincipalId);
  // Their keys for this workspace stop working now; tell open streams too (AC 6).
  await ctx.events.principalRevoked({
    principalId: targetPrincipalId,
    reason: 'membership_removed',
    workspaceId,
  });
}
