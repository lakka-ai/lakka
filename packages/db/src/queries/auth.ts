import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { authSessions, authUsers } from '../schema/auth.ts';

/** Deletes one Better Auth session by its token, e.g. one created implicitly by sign-up. */
export async function deleteAuthSessionByToken(db: Db, token: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.token, token));
}

/** Ends every session of a Better Auth user, e.g. on suspension (ID-6, AC 6). */
export async function deleteAuthSessionsForUser(db: Db, authUserId: string): Promise<number> {
  const deleted = await db
    .delete(authSessions)
    .where(eq(authSessions.userId, authUserId))
    .returning({ id: authSessions.id });
  return deleted.length;
}

/**
 * Deletes a Better Auth user with its accounts and sessions (they cascade). Used only to undo an
 * account created moments earlier whose setup or invite then failed, before any principal
 * referenced it.
 */
export async function deleteAuthUser(db: Db, authUserId: string): Promise<void> {
  await db.delete(authUsers).where(eq(authUsers.id, authUserId));
}
