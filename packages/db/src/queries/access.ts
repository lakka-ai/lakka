import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { apiKeys, memberships, principals } from '../schema/identity.ts';

/** A request in progress, by who made it and where (ADR 0063). */
export interface AccessCheck {
  /** The person, or the key. */
  principalId: string;
  /** The person, or the key's owner. */
  actingUserId: string;
  workspaceId: string;
}

/**
 * Which of these requests may still run, by the rules authentication applies to a new one: the
 * acting person is active and still a member of the workspace, and a key is also unrevoked and
 * active (ID-5, ID-6). Returns the indexes of the checks that pass. Each check is scoped by its
 * own workspace.
 */
export async function findStillAllowed(
  db: Db,
  checks: readonly AccessCheck[],
): Promise<Set<number>> {
  if (checks.length === 0) return new Set();
  const people = [...new Set(checks.map((c) => c.actingUserId))];
  const workspaces = [...new Set(checks.map((c) => c.workspaceId))];
  const keys = [
    ...new Set(checks.filter((c) => c.principalId !== c.actingUserId).map((c) => c.principalId)),
  ];
  const [members, liveKeys] = await Promise.all([
    db
      .select({ principalId: memberships.principalId, workspaceId: memberships.workspaceId })
      .from(memberships)
      .innerJoin(principals, eq(principals.id, memberships.principalId))
      .where(
        and(
          inArray(memberships.principalId, people),
          inArray(memberships.workspaceId, workspaces),
          eq(principals.status, 'active'),
        ),
      ),
    keys.length === 0
      ? Promise.resolve([])
      : db
          .select({ principalId: apiKeys.principalId })
          .from(apiKeys)
          .innerJoin(principals, eq(principals.id, apiKeys.principalId))
          .where(
            and(
              inArray(apiKeys.principalId, keys),
              isNull(apiKeys.revokedAt),
              eq(principals.status, 'active'),
            ),
          ),
  ]);
  const member = new Set(members.map((m) => `${m.principalId}:${m.workspaceId}`));
  const liveKey = new Set(liveKeys.map((k) => k.principalId));
  const allowed = new Set<number>();
  checks.forEach((c, i) => {
    const isKey = c.principalId !== c.actingUserId;
    if (
      member.has(`${c.actingUserId}:${c.workspaceId}`) &&
      (!isKey || liveKey.has(c.principalId))
    ) {
      allowed.add(i);
    }
  });
  return allowed;
}
