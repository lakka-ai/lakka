import { and, eq, inArray, isNotNull, lt, lte } from 'drizzle-orm';
import type { Db } from '../client.ts';
import type { Pool } from '../pool.ts';
import { reservations, budgetAlerts } from '../schema/budgets.ts';
import { conversations } from '../schema/conversations.ts';
import { principals } from '../schema/identity.ts';
import { mcpOauthStates, toolApprovals, toolGrants, toolInvocations } from '../schema/mcp.ts';
import { passwordResets } from '../schema/onboarding.ts';
import { retentionSettings, spanContent } from '../schema/observability.ts';

/*
 * Retention (OB-6, NF-P5, ADR 0078): the instance's periods, and the deletes that enforce them.
 * These run across every workspace, as the budget maintenance queries do: they are instance
 * maintenance, run by the worker's scheduled job or an instance admin, and never on behalf of a
 * request, so there is no workspace to scope them to.
 */

export type RetentionSettingsRow = typeof retentionSettings.$inferSelect & {
  updatedByName: string | null;
};

export async function findRetentionSettings(db: Db): Promise<RetentionSettingsRow | undefined> {
  const [row] = await db
    .select({ settings: retentionSettings, updatedByName: principals.displayName })
    .from(retentionSettings)
    .leftJoin(principals, eq(principals.id, retentionSettings.updatedBy))
    .limit(1);
  return row === undefined ? undefined : { ...row.settings, updatedByName: row.updatedByName };
}

export interface RetentionPeriods {
  spansDays: number;
  usageMonths: number;
  conversationsDays: number | null;
  toolAuditDays: number;
  budgetAlertsMonths: number;
  reservationsDays: number;
}

export async function updateRetentionSettings(
  db: Db,
  periods: RetentionPeriods,
  byPrincipalId: string,
): Promise<void> {
  await db
    .update(retentionSettings)
    .set({ ...periods, updatedAt: new Date(), updatedBy: byPrincipalId })
    .where(eq(retentionSettings.id, true));
}

export async function recordRetentionRun(
  db: Db,
  at: Date,
  deleted: Record<string, number>,
  durationMs: number,
): Promise<void> {
  await db
    .update(retentionSettings)
    .set({ lastRunAt: at, lastRunDeleted: deleted, lastRunDurationMs: durationMs })
    .where(eq(retentionSettings.id, true));
}

/** Tables partitioned by month, and the column each is partitioned on. */
const PARTITIONED = { spans: 'started_at', usage: 'created_at' } as const;
export type PartitionedTable = keyof typeof PARTITIONED;

/**
 * Removes every record of `table` older than `cutoff`: whole monthly partitions that end on or
 * before it are dropped, which is instant, and the rows before it in the one month it falls
 * inside are deleted, which touches only that partition. Returns how many records went.
 */
export async function removePartitionedBefore(
  pool: Pool,
  table: PartitionedTable,
  cutoff: Date,
): Promise<number> {
  const partitions = await pool.query<{ name: string }>(
    `select c.relname as name from pg_inherits i
       join pg_class c on c.oid = i.inhrelid
       join pg_class p on p.oid = i.inhparent
      where p.relname = $1`,
    [table],
  );
  let removed = 0;
  for (const { name } of partitions.rows) {
    const month = new RegExp(`^${table}_y(\\d{4})m(\\d{2})$`).exec(name);
    if (month === null) continue;
    const end = Date.UTC(Number(month[1]), Number(month[2]), 1);
    if (end > cutoff.getTime()) continue;
    // The name matched the pattern above, so it is safe to use as an identifier.
    const counted = await pool.query<{ n: string }>(`select count(*)::text as n from ${name}`);
    await pool.query(`drop table ${name}`);
    removed += Number(counted.rows[0]?.n ?? 0);
  }
  const rest = await pool.query(`delete from ${table} where ${PARTITIONED[table]} < $1`, [cutoff]);
  return removed + (rest.rowCount ?? 0);
}

/** How many rows a delete removed, without reading them back. */
async function count(query: PromiseLike<{ rowCount: number | null }>): Promise<number> {
  return (await query).rowCount ?? 0;
}

/** Captured content past the period its workspace chose (ADR 0077). */
export function deleteExpiredSpanContent(db: Db, now: Date): Promise<number> {
  return count(db.delete(spanContent).where(lte(spanContent.expiresAt, now)));
}

/** Conversations with no activity since `cutoff`, with their messages and files. */
export function deleteConversationsBefore(db: Db, cutoff: Date): Promise<number> {
  return count(db.delete(conversations).where(lt(conversations.updatedAt, cutoff)));
}

/** The tool audit, decided approvals and revoked standing approvals older than `cutoff`. */
export async function deleteToolRecordsBefore(db: Db, cutoff: Date): Promise<number> {
  const [invocations, approvals, grants] = await Promise.all([
    count(db.delete(toolInvocations).where(lt(toolInvocations.createdAt, cutoff))),
    count(
      db
        .delete(toolApprovals)
        .where(
          and(
            inArray(toolApprovals.status, ['approved', 'denied', 'expired']),
            lt(toolApprovals.createdAt, cutoff),
          ),
        ),
    ),
    count(
      db
        .delete(toolGrants)
        .where(and(isNotNull(toolGrants.revokedAt), lt(toolGrants.revokedAt, cutoff))),
    ),
  ]);
  return invocations + approvals + grants;
}

/** Budget alerts that are done with, older than `cutoff`. */
export function deleteBudgetAlertsBefore(db: Db, cutoff: Date): Promise<number> {
  return count(
    db
      .delete(budgetAlerts)
      .where(
        and(
          inArray(budgetAlerts.state, ['delivered', 'failed', 'no_destination']),
          lt(budgetAlerts.createdAt, cutoff),
        ),
      ),
  );
}

/** Reservations that are over, older than `cutoff`, with their lines. Live ones are kept. */
export function deleteReservationsBefore(db: Db, cutoff: Date): Promise<number> {
  return count(
    db
      .delete(reservations)
      .where(
        and(
          inArray(reservations.state, ['settled', 'denied', 'abandoned']),
          lt(reservations.createdAt, cutoff),
        ),
      ),
  );
}

/** Authorizations to MCP servers that were started and never finished. */
export function deleteExpiredMcpOAuthStates(db: Db, now: Date): Promise<number> {
  return count(db.delete(mcpOauthStates).where(lt(mcpOauthStates.expiresAt, now)));
}

/**
 * Password reset links that ran out unused (ADR 0098). A used or replaced link is deleted at
 * once; one that is never opened would otherwise stay until its person is deleted.
 */
export function deleteExpiredPasswordResets(db: Db, now: Date): Promise<number> {
  return count(db.delete(passwordResets).where(lt(passwordResets.expiresAt, now)));
}
