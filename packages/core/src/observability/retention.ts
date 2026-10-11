import { ForbiddenError, RetentionRunningError } from '@lakka/contracts';
import type {
  Principal,
  RetentionBody,
  RetentionDeleted,
  RetentionRunCounts,
  RetentionView,
} from '@lakka/contracts';
import {
  deleteBudgetAlertsBefore,
  deleteConversationsBefore,
  deleteExpiredMcpOAuthStates,
  deleteExpiredPasswordResets,
  deleteExpiredSpanContent,
  deleteReservationsBefore,
  deleteToolRecordsBefore,
  findRetentionSettings,
  recordRetentionRun,
  removePartitionedBefore,
  updateRetentionSettings,
} from '@lakka/db';
import type { Db, Pool, RetentionSettingsRow } from '@lakka/db';
import type { Logger } from '../logger.ts';

/*
 * Retention (OB-6, NF-P5, AC 21, ADR 0078). The worker runs it every day as a pg-boss job, and an
 * instance admin can run it at once. Each kind of record goes after its own period: spans and
 * usage by dropping whole months and deleting what is left of the month the cutoff falls in;
 * everything else by deleting old rows. Budget counters are rebuilt from budget_spend, not from
 * usage, so no cap moves when old usage goes.
 */

export const RETENTION_QUEUE = 'retention';
/** Every day at 03:17 UTC, a quiet hour that is not on the hour. */
export const RETENTION_SCHEDULE = '17 3 * * *';

/** Any number, distinct from the migration and partition locks. */
const RETENTION_LOCK_KEY = 0x72657465; // "rete"
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionContext {
  db: Db;
  pool: Pool;
  logger: Logger;
}

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/** The same moment, `months` calendar months earlier (UTC). */
function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** A stored run's counts. A run recorded before a kind was counted has no number for it. */
function runCounts(stored: Record<string, number>): RetentionRunCounts {
  const n = (kind: keyof RetentionDeleted) => {
    const value: unknown = stored[kind];
    return typeof value === 'number' ? value : null;
  };
  return {
    spans: n('spans'),
    spanContent: n('spanContent'),
    usage: n('usage'),
    conversations: n('conversations'),
    toolRecords: n('toolRecords'),
    budgetAlerts: n('budgetAlerts'),
    reservations: n('reservations'),
    oauthStates: n('oauthStates'),
    passwordResets: n('passwordResets'),
  };
}

function view(row: RetentionSettingsRow): RetentionView {
  return {
    spansDays: row.spansDays,
    usageMonths: row.usageMonths,
    conversationsDays: row.conversationsDays,
    toolAuditDays: row.toolAuditDays,
    budgetAlertsMonths: row.budgetAlertsMonths,
    reservationsDays: row.reservationsDays,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedBy: row.updatedByName,
    lastRun:
      row.lastRunAt === null || row.lastRunDeleted === null
        ? null
        : {
            at: row.lastRunAt.toISOString(),
            durationMs: row.lastRunDurationMs,
            deleted: runCounts(row.lastRunDeleted),
          },
  };
}

async function settings(db: Db): Promise<RetentionSettingsRow> {
  const row = await findRetentionSettings(db);
  // The migration inserts the row; its absence means the schema is not what this code expects.
  if (row === undefined) throw new Error('retention settings are missing');
  return row;
}

function requireInstanceAdmin(principal: Principal): void {
  if (principal.kind !== 'user' || !principal.isInstanceAdmin) {
    throw new ForbiddenError('only instance admins manage retention');
  }
}

export async function getRetention(ctx: { db: Db }, principal: Principal): Promise<RetentionView> {
  requireInstanceAdmin(principal);
  return view(await settings(ctx.db));
}

export async function changeRetention(
  ctx: { db: Db; logger: Logger },
  principal: Principal,
  body: RetentionBody,
): Promise<RetentionView> {
  requireInstanceAdmin(principal);
  await updateRetentionSettings(ctx.db, body, principal.actingUserId);
  ctx.logger.info('retention.changed', { principal_id: principal.actingUserId });
  return view(await settings(ctx.db));
}

/**
 * Deletes everything past its period, as of `now`. Returns what went, or null when another
 * process is already doing it: runs take turns under an advisory lock.
 */
export async function enforceRetention(
  ctx: RetentionContext,
  now: Date = new Date(),
): Promise<RetentionDeleted | null> {
  const lock = await ctx.pool.connect();
  let locked = false;
  try {
    const got = await lock.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
      RETENTION_LOCK_KEY,
    ]);
    locked = got.rows[0]?.ok === true;
    if (!locked) return null;
    const started = performance.now();
    const periods = await settings(ctx.db);
    const deleted: RetentionDeleted = {
      spans: await removePartitionedBefore(ctx.pool, 'spans', daysBefore(now, periods.spansDays)),
      spanContent: await deleteExpiredSpanContent(ctx.db, now),
      usage: await removePartitionedBefore(
        ctx.pool,
        'usage',
        monthsBefore(now, periods.usageMonths),
      ),
      conversations:
        periods.conversationsDays === null
          ? 0
          : await deleteConversationsBefore(ctx.db, daysBefore(now, periods.conversationsDays)),
      toolRecords: await deleteToolRecordsBefore(ctx.db, daysBefore(now, periods.toolAuditDays)),
      budgetAlerts: await deleteBudgetAlertsBefore(
        ctx.db,
        monthsBefore(now, periods.budgetAlertsMonths),
      ),
      reservations: await deleteReservationsBefore(
        ctx.db,
        daysBefore(now, periods.reservationsDays),
      ),
      oauthStates: await deleteExpiredMcpOAuthStates(ctx.db, now),
      passwordResets: await deleteExpiredPasswordResets(ctx.db, now),
    };
    const durationMs = Math.round(performance.now() - started);
    await recordRetentionRun(ctx.db, now, { ...deleted }, durationMs);
    ctx.logger.info('retention.enforced', {
      count: Object.values(deleted).reduce((sum, n) => sum + n, 0),
      duration_ms: durationMs,
    });
    return deleted;
  } finally {
    if (locked) await lock.query('select pg_advisory_unlock($1)', [RETENTION_LOCK_KEY]);
    lock.release();
  }
}

/**
 * Runs retention now, for an instance admin, and returns the settings with this run's result.
 * If a run is already going, it says so rather than returning the last run as if it were this
 * one (ADR 0097).
 */
export async function runRetentionNow(
  ctx: RetentionContext,
  principal: Principal,
): Promise<RetentionView> {
  requireInstanceAdmin(principal);
  if ((await enforceRetention(ctx)) === null) {
    throw new RetentionRunningError('retention is already running');
  }
  ctx.logger.info('retention.run_requested', { principal_id: principal.actingUserId });
  return view(await settings(ctx.db));
}
