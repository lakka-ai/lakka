import { and, eq, gt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../client.ts';
import { principals } from '../schema/identity.ts';
import { passwordResets } from '../schema/onboarding.ts';

/*
 * Password reset links (ADR 0098). One per person: making a new one replaces the old.
 */

/** Makes the person's reset link, replacing any earlier one. */
export async function replacePasswordReset(
  db: Db,
  reset: { principalId: string; tokenHash: string; createdByPrincipalId: string; expiresAt: Date },
): Promise<void> {
  await db
    .insert(passwordResets)
    .values(reset)
    .onConflictDoUpdate({
      target: passwordResets.principalId,
      set: {
        tokenHash: reset.tokenHash,
        createdByPrincipalId: reset.createdByPrincipalId,
        expiresAt: reset.expiresAt,
        createdAt: new Date(),
      },
    });
}

export interface PasswordResetRow {
  id: string;
  principalId: string;
  displayName: string;
  email: string | null;
  status: 'active' | 'suspended' | 'deleted';
  authSubject: string | null;
  expiresAt: Date;
  creatorStatus: 'active' | 'suspended' | 'deleted';
  creatorIsInstanceAdmin: boolean;
}

const creators = alias(principals, 'creators');

/** A link that has not expired, with the person it is for and whether its maker still may. */
export async function findPasswordReset(
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<PasswordResetRow | undefined> {
  const [row] = await db
    .select({
      id: passwordResets.id,
      principalId: passwordResets.principalId,
      displayName: principals.displayName,
      email: principals.email,
      status: principals.status,
      authSubject: principals.authSubject,
      expiresAt: passwordResets.expiresAt,
      creatorStatus: creators.status,
      creatorIsInstanceAdmin: creators.isInstanceAdmin,
    })
    .from(passwordResets)
    .innerJoin(principals, eq(principals.id, passwordResets.principalId))
    .innerJoin(creators, eq(creators.id, passwordResets.createdByPrincipalId))
    .where(and(eq(passwordResets.tokenHash, tokenHash), gt(passwordResets.expiresAt, now)))
    .limit(1);
  return row;
}

/** Deletes a used link. False if it was used or replaced in the meantime. */
export async function deletePasswordReset(db: Db, id: string, tokenHash: string): Promise<boolean> {
  const gone = await db
    .delete(passwordResets)
    .where(and(eq(passwordResets.id, id), eq(passwordResets.tokenHash, tokenHash)))
    .returning({ id: passwordResets.id });
  return gone.length > 0;
}
