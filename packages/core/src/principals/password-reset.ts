import { createHash, randomBytes } from 'node:crypto';
import { NotFoundError, PasswordResetInvalidError } from '@lakka/contracts';
import type {
  CreatedPasswordReset,
  PasswordResetPreview,
  Principal,
  UsePasswordResetBody,
} from '@lakka/contracts';
import {
  deleteAuthSessionsForUser,
  deletePasswordReset,
  findLivePerson,
  findPasswordReset,
  replacePasswordReset,
} from '@lakka/db';
import type { Db, PasswordResetRow } from '@lakka/db';
import type { AuthContext } from '../auth/authenticate.ts';
import type { ServiceContext } from '../context.ts';
import { requireInstanceAdmin } from './service.ts';

/*
 * Password reset links (ID-2, ID-6, ADR 0098). There is no email to send a reset to, so an
 * instance admin makes a link for one person and passes it on, as with invites. The link works
 * once, for a day, and only while its maker is still an active instance admin: a delegation,
 * like an invite (invariant 2). Using it sets the password, for someone who signs in through a
 * provider too, and signs the person out everywhere.
 */

export const PASSWORD_RESET_LIFETIME_MS = 24 * 60 * 60 * 1000;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createPasswordReset(
  ctx: ServiceContext,
  principal: Principal,
  targetPrincipalId: string,
  now: Date = new Date(),
): Promise<CreatedPasswordReset> {
  requireInstanceAdmin(principal);
  const person = await findLivePerson(ctx.db, targetPrincipalId);
  if (person?.authSubject === null || person === undefined) {
    throw new NotFoundError('no user with this id');
  }
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_LIFETIME_MS);
  await replacePasswordReset(ctx.db, {
    principalId: person.id,
    tokenHash: digest(token),
    createdByPrincipalId: principal.actingUserId,
    expiresAt,
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

/** Whether a link may be used: for an active person, made by someone who still may. */
export function resetUsable(row: PasswordResetRow): boolean {
  return (
    row.status === 'active' &&
    row.authSubject !== null &&
    row.email !== null &&
    row.creatorStatus === 'active' &&
    row.creatorIsInstanceAdmin
  );
}

async function usableReset(db: Db, token: string): Promise<PasswordResetRow> {
  const row = await findPasswordReset(db, digest(token), new Date());
  if (row === undefined || !resetUsable(row)) {
    throw new PasswordResetInvalidError('this reset link cannot be used');
  }
  return row;
}

export async function previewPasswordReset(
  ctx: { db: Db },
  token: string,
): Promise<PasswordResetPreview> {
  const row = await usableReset(ctx.db, token);
  return {
    displayName: row.displayName,
    // usableReset refuses a link for someone without an email.
    email: row.email ?? '',
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Sets the new password and uses up the link. A person who signed in only through a provider
 * gets a password as well. Every session of theirs ends, so whoever had the old password is
 * signed out; their keys are left alone, and an admin revokes those separately.
 */
export async function usePasswordReset(
  ctx: AuthContext,
  body: UsePasswordResetBody,
): Promise<{ principalId: string }> {
  const row = await usableReset(ctx.db, body.token);
  // usableReset refuses a link for someone without a Better Auth user.
  const userId = row.authSubject ?? '';
  const auth = await ctx.auth.$context;
  const hash = await auth.password.hash(body.password);
  if (!(await deletePasswordReset(ctx.db, row.id, digest(body.token)))) {
    throw new PasswordResetInvalidError('this reset link cannot be used');
  }
  // As Better Auth's own admin plugin sets a password (setUserPassword).
  if ((await auth.internalAdapter.findCredentialAccount(userId)) === null) {
    await auth.internalAdapter.createAccount({
      userId,
      providerId: 'credential',
      accountId: userId,
      password: hash,
    });
  } else {
    await auth.internalAdapter.updatePassword(userId, hash);
  }
  await deleteAuthSessionsForUser(ctx.db, userId);
  return { principalId: row.principalId };
}
