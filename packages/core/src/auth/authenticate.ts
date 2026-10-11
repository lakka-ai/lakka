import { UnauthenticatedError } from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import { findKeyForAuth, findPrincipalByAuthSubject, touchKey, touchPrincipal } from '@lakka/db';
import { hashKeySecret, looksLikeKeySecret } from '../keys/secret.ts';
import type { ServiceContext } from '../context.ts';
import type { Auth } from './auth.ts';
import { ensureUserPrincipal, toPrincipal } from './principals.ts';

/**
 * What a surface extracted from the transport. Surfaces only extract; core decides who it is
 * (CLAUDE.md invariant 1, ADR 0020).
 */
export type Credential =
  | { kind: 'session'; headers: Headers }
  | { kind: 'api_key'; secret: string };

export interface AuthContext extends ServiceContext {
  auth: Auth;
}

/**
 * Resolves a credential to a Principal (ID-1), or throws UnauthenticatedError. Nothing is
 * cached, so revocation and suspension apply to the next request (ID-6). Database errors
 * propagate: failing closed beats serving an unauthenticated request (invariant 3).
 */
export async function authenticate(ctx: AuthContext, credential: Credential): Promise<Principal> {
  return credential.kind === 'session'
    ? authenticateSession(ctx, credential.headers)
    : authenticateKey(ctx, credential.secret);
}

/** Whether a person's last activity is old enough to record again; touchPrincipal also checks. */
function isStale(lastActiveAt: Date | null): boolean {
  return lastActiveAt === null || Date.now() - lastActiveAt.getTime() > 5 * 60_000;
}

async function authenticateSession(ctx: AuthContext, headers: Headers): Promise<Principal> {
  const session = await ctx.auth.api.getSession({ headers });
  if (session === null) throw new UnauthenticatedError('no valid session');
  const row =
    (await findPrincipalByAuthSubject(ctx.db, session.user.id)) ??
    (await ensureUserPrincipal(ctx.db, session.user));
  if (row.status !== 'active') throw new UnauthenticatedError('the principal is suspended');
  if (isStale(row.lastActiveAt)) await touchPrincipal(ctx.db, row.id);
  return toPrincipal(row);
}

/**
 * A key works only while it is not revoked, it and its owner are active, and its owner is still
 * a member of the key's workspace (ID-5, ID-6, NF-S2). Every failure reads the same to the
 * caller, so a probe cannot tell a revoked key from a mistyped one.
 */
async function authenticateKey(ctx: AuthContext, secret: string): Promise<Principal> {
  const refused = new UnauthenticatedError('invalid API key');
  if (!looksLikeKeySecret(secret)) throw refused;
  const key = await findKeyForAuth(ctx.db, hashKeySecret(secret));
  if (
    key === undefined ||
    key.revokedAt !== null ||
    key.keyStatus !== 'active' ||
    key.ownerStatus !== 'active' ||
    key.ownerRole === null
  ) {
    throw refused;
  }
  await touchKey(ctx.db, key.keyId);
  // A key acts for its owner, so its use is the owner's activity on the People page.
  await touchPrincipal(ctx.db, key.ownerPrincipalId);
  return {
    id: key.keyPrincipalId,
    kind: 'key',
    displayName: key.name,
    actingUserId: key.ownerPrincipalId,
    isInstanceAdmin: false,
    workspaceScope: key.workspaceId,
  };
}
