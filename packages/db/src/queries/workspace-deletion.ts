import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { BudgetPeriod } from '@lakka/contracts';
import type { Db } from '../client.ts';
import { alertWebhooks, budgets, budgetSpend, reservations } from '../schema/budgets.ts';
import { conversations } from '../schema/conversations.ts';
import { apiKeys, memberships, workspaces } from '../schema/identity.ts';
import { mcpServers, toolApprovals, toolInvocations } from '../schema/mcp.ts';
import { spanContent, spans } from '../schema/observability.ts';
import { invites } from '../schema/onboarding.ts';
import { providerConfigs } from '../schema/providers.ts';
import { routes } from '../schema/routing.ts';

/*
 * Deleting a workspace (ID-8, ADR 0104), in two steps. The first, in one transaction, ends all
 * access: the workspace becomes a tombstone and what lets anyone in or acts for it goes. The
 * second, run by the purge job, removes what it held, in batches, and may run any number of
 * times. What records spend stays: usage, settled reservations and the tool audit, without its
 * arguments.
 */

export interface DeletedWorkspace {
  /** People who were members, whose open requests in it must end. */
  memberIds: string[];
  /** Its keys' principals, now revoked. */
  keyPrincipalIds: string[];
}

/**
 * Makes the workspace a tombstone and removes what gives access to it, in one transaction.
 * Returns undefined when there is no such workspace, or it is already deleted.
 */
export async function tombstoneWorkspace(
  db: Db,
  workspaceId: string,
  deletedByPrincipalId: string,
): Promise<DeletedWorkspace | undefined> {
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
      .for('update');
    if (workspace === undefined) return undefined;

    const members = await tx
      .delete(memberships)
      .where(eq(memberships.workspaceId, workspaceId))
      .returning({ id: memberships.principalId });
    // Revoked, not tombstoned: their owners still exist, and the instance report keeps naming
    // which key spent what (ADR 0104).
    const keys = await tx
      .update(apiKeys)
      .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())` })
      .where(eq(apiKeys.workspaceId, workspaceId))
      .returning({ id: apiKeys.principalId });
    await tx.delete(invites).where(eq(invites.workspaceId, workspaceId));
    await tx.delete(providerConfigs).where(eq(providerConfigs.workspaceId, workspaceId));
    // Its tools, standing approvals, per-person credentials and OAuth states go with the servers.
    await tx.delete(mcpServers).where(eq(mcpServers.workspaceId, workspaceId));
    await tx
      .update(toolApprovals)
      .set({ status: 'expired' })
      .where(and(eq(toolApprovals.workspaceId, workspaceId), eq(toolApprovals.status, 'pending')));
    await tx.delete(alertWebhooks).where(eq(alertWebhooks.workspaceId, workspaceId));
    await tx
      .update(workspaces)
      .set({
        deletedAt: sql`now()`,
        deletedByPrincipalId,
        // Frees the old slug for a new workspace; ids are lowercase hex, so this passes its check.
        slug: `deleted-${workspaceId}`,
      })
      .where(eq(workspaces.id, workspaceId));
    return { memberIds: members.map((m) => m.id), keyPrincipalIds: keys.map((k) => k.id) };
  });
}

/** Deleted workspaces the purge job has not finished with, oldest first. */
export async function listUnpurgedWorkspaces(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(isNotNull(workspaces.deletedAt), isNull(workspaces.purgedAt)))
    .orderBy(asc(workspaces.deletedAt));
  return rows.map((r) => r.id);
}

async function rowCount(query: PromiseLike<{ rowCount: number | null }>): Promise<number> {
  return (await query).rowCount ?? 0;
}

/**
 * Removes up to `limit` of a deleted workspace's records, the content first: captured content,
 * spans, conversations (with their messages and files), then the tool audit's arguments.
 * Returns how many rows it touched; 0 means none are left.
 */
export async function purgeWorkspaceContent(
  db: Db,
  workspaceId: string,
  limit: number,
): Promise<number> {
  const deleted = and(eq(workspaces.id, workspaceId), isNotNull(workspaces.deletedAt));
  // Only ever a deleted workspace: a wrong id must not empty a live one.
  const [tombstone] = await db.select({ id: workspaces.id }).from(workspaces).where(deleted);
  if (tombstone === undefined) return 0;

  const content = await rowCount(
    db.execute(sql`
      delete from ${spanContent} c
       using (select trace_id, span_id from ${spanContent}
               where workspace_id = ${workspaceId} limit ${limit}) d
       where c.trace_id = d.trace_id and c.span_id = d.span_id`),
  );
  if (content > 0) return content;
  const traced = await rowCount(
    db.execute(sql`
      delete from ${spans} s
       using (select trace_id, span_id, started_at from ${spans}
               where workspace_id = ${workspaceId} limit ${limit}) d
       where s.trace_id = d.trace_id and s.span_id = d.span_id and s.started_at = d.started_at`),
  );
  if (traced > 0) return traced;
  const said = await rowCount(
    db
      .delete(conversations)
      .where(
        inArray(
          conversations.id,
          db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.workspaceId, workspaceId))
            .limit(limit),
        ),
      ),
  );
  if (said > 0) return said;
  // The tool audit keeps who ran what, when and how it ended (TL-6); the arguments go.
  return rowCount(
    db
      .update(toolInvocations)
      .set({ arguments: null })
      .where(
        inArray(
          toolInvocations.id,
          db
            .select({ id: toolInvocations.id })
            .from(toolInvocations)
            .where(
              and(
                eq(toolInvocations.workspaceId, workspaceId),
                isNotNull(toolInvocations.arguments),
              ),
            )
            .limit(limit),
        ),
      ),
  );
}

/** A removed cap's counters, for the caller to delete from Valkey. */
export interface RemovedCap {
  budgetId: string;
  period: BudgetPeriod;
  /** Every period it recorded spend for. */
  periodStarts: Date[];
}

export type FinishPurge =
  | { outcome: 'finished'; removedCaps: RemovedCap[] }
  /** A request in it still holds a reservation; caps stay until it settles or lapses. */
  | { outcome: 'reservations_open' };

/**
 * Once its content is gone: removes its routes and, when no reservation in it is still open,
 * its caps, then marks the workspace purged. A reservation line cascades from its cap, so
 * removing a cap under an open request would leave that request's hold unreleased (ADR 0104).
 */
export async function finishWorkspacePurge(db: Db, workspaceId: string): Promise<FinishPurge> {
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNotNull(workspaces.deletedAt)))
      .for('update');
    if (workspace === undefined) return { outcome: 'finished', removedCaps: [] };
    const [open] = await tx
      .select({ id: reservations.id })
      .from(reservations)
      .where(
        and(
          eq(reservations.workspaceId, workspaceId),
          inArray(reservations.state, ['pending', 'active']),
        ),
      )
      .limit(1);
    if (open !== undefined) return { outcome: 'reservations_open' };

    // Examples and centroids go with their routes.
    await tx.delete(routes).where(eq(routes.workspaceId, workspaceId));
    const caps = await tx
      .select({ id: budgets.id, period: budgets.period })
      .from(budgets)
      .where(eq(budgets.workspaceId, workspaceId));
    const capIds = caps.map((c) => c.id);
    const spent =
      capIds.length === 0
        ? []
        : await tx
            .select({ budgetId: budgetSpend.budgetId, periodStart: budgetSpend.periodStart })
            .from(budgetSpend)
            .where(inArray(budgetSpend.budgetId, capIds));
    // Their spend rows, reservation lines and alerts go with them.
    if (capIds.length > 0) await tx.delete(budgets).where(inArray(budgets.id, capIds));
    await tx
      .update(workspaces)
      .set({ purgedAt: sql`now()` })
      .where(eq(workspaces.id, workspaceId));
    return {
      outcome: 'finished',
      removedCaps: caps.map((c) => ({
        budgetId: c.id,
        period: c.period,
        periodStarts: spent.filter((s) => s.budgetId === c.id).map((s) => s.periodStart),
      })),
    };
  });
}
