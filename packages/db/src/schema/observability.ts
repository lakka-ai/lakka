import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  integer,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Traces, stored locally by default (OB-1, OB-3, ADR 0076): one row per span, as the exporter
 * receives it. Partitioned by month on started_at (the migration adds PARTITION BY, which Drizzle
 * cannot express), so retention drops whole partitions (ADR 0075). Partitions are created ahead
 * of time by ensureMonthlyPartitions.
 *
 * Never content (OB-4, invariant 9): attributes pass an allowlist of known names on the way in,
 * and prompt or response text, when a workspace opts in, goes to span_content, never
 * here. Workspace and request are columns, so a trace is read within its workspace only (AC 16).
 */

/**
 * What was said in one model call, kept only for a workspace that opted in (OB-4, ADR 0077):
 * the prompt as sent and the reply as received, for troubleshooting. A workspace that has not
 * opted in writes nothing here. Each row carries its own expiry, since each workspace sets its own
 * period; retention deletes by expires_at (ADR 0075 Q1).
 */
export const spanContent = pgTable(
  'span_content',
  {
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    requestId: uuid('request_id').notNull(),
    prompt: jsonb('prompt').$type<unknown>().notNull(),
    response: jsonb('response').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'span_content_pkey', columns: [t.traceId, t.spanId] }),
    index('span_content_workspace_created_idx').on(t.workspaceId, t.createdAt),
    index('span_content_request_idx').on(t.requestId),
    index('span_content_expires_idx').on(t.expiresAt),
    check('span_content_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const SPAN_KINDS = ['internal', 'server', 'client', 'producer', 'consumer'] as const;
export const SPAN_STATUSES = ['unset', 'ok', 'error'] as const;

export const spans = pgTable(
  'spans',
  {
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    workspaceId: uuid('workspace_id'),
    requestId: uuid('request_id'),
    name: text('name').notNull(),
    kind: text('kind', { enum: SPAN_KINDS }).notNull(),
    status: text('status', { enum: SPAN_STATUSES }).notNull(),
    /** The failure kind, from the error.type attribute, for finding failed spans quickly. */
    errorType: text('error_type'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    durationMs: doublePrecision('duration_ms').notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    /** What happened during the span, such as a candidate skipped: name, offset, attributes. */
    events: jsonb('events')
      .$type<{ name: string; atMs: number; attributes: Record<string, unknown> }[]>()
      .notNull()
      .default([]),
  },
  (t) => [
    primaryKey({ name: 'spans_pkey', columns: [t.traceId, t.spanId, t.startedAt] }),
    index('spans_workspace_started_idx').on(t.workspaceId, t.startedAt),
    index('spans_request_idx').on(t.requestId),
    index('spans_trace_idx').on(t.traceId),
    // The request list reads root spans only, newest first (ADR 0079).
    index('spans_requests_idx')
      .on(t.workspaceId, t.startedAt)
      .where(sql`${t.name} = 'request'`),
    check(
      'spans_kind_check',
      sql`${t.kind} in ('internal', 'server', 'client', 'producer', 'consumer')`,
    ),
    check('spans_status_check', sql`${t.status} in ('unset', 'ok', 'error')`),
    check('spans_duration_check', sql`${t.durationMs} >= 0`),
  ],
);

/**
 * How long each kind of record is kept (OB-6, NF-P5, ADR 0075 Q1, ADR 0078): one row for the
 * instance, set by its admins. Captured content keeps each workspace's own period instead
 * (span_content.expires_at). Conversations are kept until deleted unless a period is set. The
 * last enforcement's time and counts are kept here too, so the admin page can show them.
 */
export const retentionSettings = pgTable(
  'retention_settings',
  {
    /** Always true: there is one row. */
    id: boolean('id').primaryKey().default(true),
    spansDays: integer('spans_days').notNull().default(30),
    usageMonths: integer('usage_months').notNull().default(13),
    conversationsDays: integer('conversations_days'),
    toolAuditDays: integer('tool_audit_days').notNull().default(90),
    budgetAlertsMonths: integer('budget_alerts_months').notNull().default(13),
    reservationsDays: integer('reservations_days').notNull().default(30),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    updatedBy: uuid('updated_by'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunDeleted: jsonb('last_run_deleted').$type<Record<string, number>>(),
    /** How long the last run took; null for runs recorded before it was kept (ADR 0097). */
    lastRunDurationMs: integer('last_run_duration_ms'),
  },
  (t) => [
    check('retention_settings_singleton_check', sql`${t.id}`),
    check(
      'retention_settings_ranges_check',
      sql`${t.spansDays} between 1 and 365
        and ${t.usageMonths} between 2 and 120
        and (${t.conversationsDays} is null or ${t.conversationsDays} between 1 and 3650)
        and ${t.toolAuditDays} between 1 and 3650
        and ${t.budgetAlertsMonths} between 1 and 120
        and ${t.reservationsDays} between 1 and 365`,
    ),
  ],
);
