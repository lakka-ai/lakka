import { and, asc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import type { Pool } from '../pool.ts';
import { usage } from '../schema/usage.ts';

/*
 * Usage records (BG-8, ADR 0039). Reads are scoped by workspace like all tenant data.
 */

export type UsageInsert = Omit<typeof usage.$inferInsert, 'id' | 'createdAt'>;
export type UsageRow = typeof usage.$inferSelect;

export async function insertUsage(db: Db, row: UsageInsert): Promise<UsageRow> {
  const [inserted] = await db.insert(usage).values(row).returning();
  if (inserted === undefined) throw new Error('usage insert returned nothing');
  return inserted;
}

export async function listUsageForRequest(
  db: Db,
  workspaceId: string,
  requestId: string,
): Promise<UsageRow[]> {
  return db
    .select()
    .from(usage)
    .where(and(eq(usage.workspaceId, workspaceId), eq(usage.requestId, requestId)))
    .orderBy(asc(usage.attempt));
}

/** Requests a route decided and the user kept, with their tokens and what they cost. */
export interface RoutedUsage {
  routeId: string;
  requests: number;
  uncachedInputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  outputTokens: bigint;
  costMicroUsd: bigint;
}

/**
 * Totals per route since a time, for the override summary (RT-10, ADR 0048). Counts requests,
 * not attempts; tokens and cost include every attempt, since each was paid for.
 */
export async function summarizeRoutedUsage(
  db: Db,
  workspaceId: string,
  since: Date,
): Promise<RoutedUsage[]> {
  const rows = await db
    .select({
      routeId: usage.routeId,
      requests: sql<number>`count(distinct ${usage.requestId})::int`,
      uncachedInputTokens: sql<string>`coalesce(sum(${usage.uncachedInputTokens}), 0)::text`,
      cacheReadTokens: sql<string>`coalesce(sum(${usage.cacheReadTokens}), 0)::text`,
      cacheWriteTokens: sql<string>`coalesce(sum(${usage.cacheWriteTokens}), 0)::text`,
      outputTokens: sql<string>`coalesce(sum(${usage.outputTokens}), 0)::text`,
      costMicroUsd: sql<string>`coalesce(sum(${usage.costMicroUsd}), 0)::text`,
    })
    .from(usage)
    .where(
      and(
        eq(usage.workspaceId, workspaceId),
        gte(usage.createdAt, since),
        isNotNull(usage.routeId),
        eq(usage.wasOverridden, false),
        inArray(usage.resolutionRule, ['signal', 'classified', 'sticky']),
      ),
    )
    .groupBy(usage.routeId);
  return rows.flatMap((r) =>
    r.routeId === null
      ? []
      : [
          {
            routeId: r.routeId,
            requests: r.requests,
            uncachedInputTokens: BigInt(r.uncachedInputTokens),
            cacheReadTokens: BigInt(r.cacheReadTokens),
            cacheWriteTokens: BigInt(r.cacheWriteTokens),
            outputTokens: BigInt(r.outputTokens),
            costMicroUsd: BigInt(r.costMicroUsd),
          },
        ],
  );
}

export interface OverrideCount {
  routeId: string;
  /** The model the user chose instead; after a budget fallback, the one they chose (BG-7). */
  model: string;
  /** The model the route had chosen. */
  overriddenModel: string;
  requests: number;
}

/**
 * Overrides of routed conversations since a time, per route and pair of models (RT-9, RT-10).
 * Each request counts once, by its earliest recorded attempt: that names the model the user
 * chose, and later attempts are failover. When a cap sent the request to a cheaper model, the
 * model the user chose is kept in budget_fallback_from, so that one counts.
 */
export async function listOverrideCounts(
  db: Db,
  workspaceId: string,
  since: Date,
): Promise<OverrideCount[]> {
  const requests = await db
    .selectDistinctOn([usage.requestId], {
      routeId: usage.routeId,
      model: sql<string>`coalesce(${usage.budgetFallbackFrom}, ${usage.model})`,
      overriddenModel: usage.overriddenModel,
    })
    .from(usage)
    .where(
      and(
        eq(usage.workspaceId, workspaceId),
        gte(usage.createdAt, since),
        eq(usage.wasOverridden, true),
        isNotNull(usage.routeId),
      ),
    )
    .orderBy(usage.requestId, asc(usage.attempt));
  const counts = new Map<string, OverrideCount>();
  for (const r of requests) {
    if (r.routeId === null || r.overriddenModel === null) continue;
    const key = JSON.stringify([r.routeId, r.model, r.overriddenModel]);
    const count = counts.get(key) ?? {
      routeId: r.routeId,
      model: r.model,
      overriddenModel: r.overriddenModel,
      requests: 0,
    };
    count.requests += 1;
    counts.set(key, count);
  }
  return [...counts.values()];
}

/** Any number, so the advisory lock is distinct from the migration lock. */
const PARTITION_LOCK_KEY = 0x75736167; // "usag"

/** Tables partitioned by month (ADR 0039, ADR 0076), and the column they are partitioned on. */
export const MONTHLY_PARTITIONED_TABLES = ['usage', 'spans'] as const;

function monthStart(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Creates the monthly partitions of every partitioned table for the month of `now` and the next
 * `monthsAhead`, if they do not exist yet. Month bounds are UTC. Safe to run from several
 * processes at once: they take turns under an advisory lock. Returns how many partitions it
 * created.
 */
export async function ensureMonthlyPartitions(
  pool: Pool,
  now: Date = new Date(),
  monthsAhead = 2,
): Promise<number> {
  const client = await pool.connect();
  let created = 0;
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [PARTITION_LOCK_KEY]);
    for (const table of MONTHLY_PARTITIONED_TABLES) {
      for (let i = 0; i <= monthsAhead; i += 1) {
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth() + i;
        const from = monthStart(year, month);
        const to = monthStart(year, month + 1);
        // Built from a fixed table name and digits only, so safe to use as an identifier.
        const name = `${table}_y${from.slice(0, 4)}m${from.slice(5, 7)}`;
        const exists = await client.query('select to_regclass($1) is not null as present', [name]);
        if ((exists.rows[0] as { present: boolean } | undefined)?.present === true) continue;
        await client.query(
          `create table ${name} partition of ${table} for values from ('${from} 00:00:00+00') to ('${to} 00:00:00+00')`,
        );
        created += 1;
      }
    }
    await client.query('commit');
    return created;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
