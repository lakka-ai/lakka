import { ForbiddenError, NotFoundError } from '@lakka/contracts';
import type { IssuedKey, KeyView, Principal } from '@lakka/contracts';
import { findKey, findMembership, findWorkspace, insertKey, listKeys, revokeKey } from '@lakka/db';
import type { KeyRow } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import { decide } from '../authz/policy.ts';
import type { WorkspaceAction } from '../authz/policy.ts';
import { generateKeySecret } from './secret.ts';

/*
 * Issuing, listing and revoking API keys (ID-5, ID-6). A member issues keys for themselves in
 * one workspace; admins see and revoke every key in theirs. Keys cannot manage keys.
 */

export type KeyContext = ServiceContext;

function view(row: KeyRow): KeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    workspaceId: row.workspaceId,
    owner: { principalId: row.ownerPrincipalId, displayName: row.ownerDisplayName },
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

async function authorize(
  ctx: KeyContext,
  principal: Principal,
  workspaceId: string,
  action: WorkspaceAction,
  targetPrincipalId?: string,
) {
  if ((await findWorkspace(ctx.db, workspaceId)) === undefined) {
    throw new NotFoundError('workspace not found');
  }
  const role = (await findMembership(ctx.db, workspaceId, principal.actingUserId))?.role ?? null;
  const decision = decide({
    principal,
    action,
    role,
    workspaceId,
    ...(targetPrincipalId === undefined ? {} : { targetPrincipalId }),
  });
  if (decision === 'hidden') throw new NotFoundError('workspace not found');
  if (decision === 'deny') throw new ForbiddenError('your role does not allow this');
  return role;
}

export async function issueKey(
  ctx: KeyContext,
  principal: Principal,
  workspaceId: string,
  input: { name: string },
): Promise<IssuedKey> {
  await authorize(ctx, principal, workspaceId, 'keys.issue');
  const { secret, prefix, hash } = generateKeySecret();
  const row = await insertKey(ctx.db, workspaceId, {
    ownerPrincipalId: principal.actingUserId,
    name: input.name,
    hash,
    prefix,
  });
  return { key: view(row), secret };
}

/** Admins (and instance admins) see every key in the workspace; members see their own. */
export async function listWorkspaceKeys(
  ctx: KeyContext,
  principal: Principal,
  workspaceId: string,
): Promise<KeyView[]> {
  const role = await authorize(ctx, principal, workspaceId, 'keys.list');
  const seesAll = role === 'admin' || (principal.isInstanceAdmin && principal.kind === 'user');
  const rows = await listKeys(ctx.db, workspaceId, seesAll ? undefined : principal.actingUserId);
  return rows.map(view);
}

/** Revokes a key, effective on its next request (ID-6). The owner or an admin may do this. */
export async function revokeWorkspaceKey(
  ctx: KeyContext,
  principal: Principal,
  workspaceId: string,
  keyId: string,
): Promise<void> {
  const key = await findKey(ctx.db, workspaceId, keyId);
  // Check the workspace before the key, so an outsider learns nothing about either.
  await authorize(ctx, principal, workspaceId, 'keys.revoke', key?.ownerPrincipalId);
  if (key === undefined) throw new NotFoundError('key not found');
  await revokeKey(ctx.db, workspaceId, keyId);
  await ctx.events.principalRevoked({
    principalId: key.principalId,
    reason: 'key_revoked',
    workspaceId,
  });
}
