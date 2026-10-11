import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { principals, workspaces } from '../schema/identity.ts';
import { spanContent } from '../schema/observability.ts';

/*
 * Content capture (OB-4, NF-P3, ADR 0077): a workspace's opt-in, who changed it and when, and the
 * content recorded while it is on. The setting is part of the policy snapshot, so changing it
 * moves the workspace's policy version on, as every policy change does.
 */

export interface ContentCaptureRow {
  enabled: boolean;
  retentionDays: number;
  changedAt: Date | null;
  changedBy: { id: string; displayName: string } | null;
}

export async function findContentCapture(
  db: Db,
  workspaceId: string,
): Promise<ContentCaptureRow | undefined> {
  const [row] = await db
    .select({
      enabled: workspaces.contentCapture,
      retentionDays: workspaces.contentRetentionDays,
      changedAt: workspaces.contentCaptureChangedAt,
      changedById: principals.id,
      changedByName: principals.displayName,
    })
    .from(workspaces)
    .leftJoin(principals, eq(principals.id, workspaces.contentCaptureChangedBy))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (row === undefined) return undefined;
  return {
    enabled: row.enabled,
    retentionDays: row.retentionDays,
    changedAt: row.changedAt,
    changedBy:
      row.changedById === null || row.changedByName === null
        ? null
        : { id: row.changedById, displayName: row.changedByName },
  };
}

export async function setContentCapture(
  db: Db,
  workspaceId: string,
  setting: { enabled: boolean; retentionDays: number },
  byPrincipalId: string,
): Promise<void> {
  await db
    .update(workspaces)
    .set({
      contentCapture: setting.enabled,
      contentRetentionDays: setting.retentionDays,
      contentCaptureChangedAt: new Date(),
      contentCaptureChangedBy: byPrincipalId,
      policyVersion: sql`${workspaces.policyVersion} + 1`,
    })
    .where(eq(workspaces.id, workspaceId));
}

export type NewSpanContent = typeof spanContent.$inferInsert;
export type SpanContentRow = typeof spanContent.$inferSelect;

export async function insertSpanContent(db: Db, row: NewSpanContent): Promise<void> {
  await db.insert(spanContent).values(row).onConflictDoNothing();
}

/** What was recorded for one request in a workspace, oldest first. */
export async function listSpanContentForRequest(
  db: Db,
  workspaceId: string,
  requestId: string,
): Promise<SpanContentRow[]> {
  return db
    .select()
    .from(spanContent)
    .where(and(eq(spanContent.workspaceId, workspaceId), eq(spanContent.requestId, requestId)))
    .orderBy(asc(spanContent.createdAt));
}
