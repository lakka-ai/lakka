import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { REFUSAL_CODES } from '@lakka/contracts';
import type { RequestOutcome } from '@lakka/contracts';
import type { Db } from '../client.ts';
import { principals } from '../schema/identity.ts';
import { spans } from '../schema/observability.ts';
import { usage } from '../schema/usage.ts';

/*
 * The local trace store (OB-3, ADR 0076). Spans are written in batches by the exporter and read
 * within one workspace only (AC 16). Rows are never updated: a span is final when it is exported.
 */

export type NewSpan = typeof spans.$inferInsert;
export type SpanRow = typeof spans.$inferSelect;

/** Writes a batch of finished spans. A span already stored is left as it is. */
export async function insertSpans(db: Db, rows: readonly NewSpan[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(spans)
    .values([...rows])
    .onConflictDoNothing();
}

/** Every span of one request in a workspace, oldest first. */
export async function listSpansForRequest(
  db: Db,
  workspaceId: string,
  requestId: string,
): Promise<SpanRow[]> {
  return db
    .select()
    .from(spans)
    .where(and(eq(spans.workspaceId, workspaceId), eq(spans.requestId, requestId)))
    .orderBy(asc(spans.startedAt));
}

export interface RequestFilter {
  workspaceId: string;
  /** Only this person's requests, their own and their keys'. */
  actingUserId?: string;
  surface?: string;
  outcome?: RequestOutcome;
  from?: Date;
  /** Exclusive. */
  until?: Date;
}

const attr = (name: string) => sql`${spans.attributes}->>${name}`;
const has = (name: string) => sql`${spans.attributes} ? ${name}`;
const refusal = inArray(spans.errorType, [...REFUSAL_CODES]);
const endedBy = (outcome: string) => sql`coalesce(${attr('lakka.outcome')}, '') = ${outcome}`;
const notError = sql`${spans.status} <> 'error'`;

/**
 * Which requests a kind of outcome covers (ADR 0095). The same rules as the request list's
 * words: refused before anything was charged, failed after it was sent or when a reply broke
 * off, stopped by the person, answered by a cheaper model, or answered.
 */
function outcomeWhere(outcome: RequestOutcome): SQL | undefined {
  const cheaper = has('lakka.budget.fallback_model');
  const endedWell = sql`not (${endedBy('aborted')} or ${endedBy('interrupted')})`;
  switch (outcome) {
    case 'refused':
      return and(eq(spans.status, 'error'), refusal);
    case 'failed':
      return sql`((${spans.status} = 'error' and (${spans.errorType} is null or not ${refusal})) or ${endedBy('interrupted')})`;
    case 'stopped':
      return and(notError, endedBy('aborted'));
    case 'cheaper':
      return and(notError, cheaper, endedWell);
    case 'completed':
      return and(notError, sql`not ${cheaper}`, endedWell);
  }
}

/**
 * Root spans of the requests that match: one per request, a request that continued another
 * after an approval left out, since it is read as part of the one it continued (ADR 0095).
 */
function requestWhere(filter: RequestFilter): SQL | undefined {
  return and(
    eq(spans.workspaceId, filter.workspaceId),
    eq(spans.name, 'request'),
    sql`not ${has('lakka.continues_request_id')}`,
    filter.actingUserId === undefined
      ? undefined
      : sql`${attr('lakka.acting_user_id')} = ${filter.actingUserId}`,
    filter.surface === undefined ? undefined : sql`${attr('lakka.surface')} = ${filter.surface}`,
    filter.outcome === undefined ? undefined : outcomeWhere(filter.outcome),
    filter.from === undefined ? undefined : gte(spans.startedAt, filter.from),
    filter.until === undefined ? undefined : lt(spans.startedAt, filter.until),
  );
}

/**
 * One page of the request list, newest first (ADR 0079), after `before` when given. Requests
 * that started at the same moment are ordered by span id, so a page never skips one.
 */
export async function listRequestRoots(
  db: Db,
  filter: RequestFilter & { before?: { at: Date; spanId: string }; limit: number },
): Promise<SpanRow[]> {
  return db
    .select()
    .from(spans)
    .where(
      and(
        requestWhere(filter),
        filter.before === undefined
          ? undefined
          : sql`(${spans.startedAt}, ${spans.spanId}) < (${filter.before.at}, ${filter.before.spanId})`,
      ),
    )
    .orderBy(desc(spans.startedAt), desc(spans.spanId))
    .limit(filter.limit);
}

/** How many requests match, over every page. */
export async function countRequestRoots(db: Db, filter: RequestFilter): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spans)
    .where(requestWhere(filter));
  return row?.n ?? 0;
}

/** The root spans of these requests in a workspace, continuations included. */
export async function listRootsForRequests(
  db: Db,
  workspaceId: string,
  requestIds: readonly string[],
): Promise<SpanRow[]> {
  if (requestIds.length === 0) return [];
  return db
    .select()
    .from(spans)
    .where(
      and(
        eq(spans.workspaceId, workspaceId),
        eq(spans.name, 'request'),
        inArray(spans.requestId, [...requestIds]),
      ),
    );
}

/** What each request cost, over all its attempts, from its usage records. */
export async function sumRequestCosts(
  db: Db,
  workspaceId: string,
  requestIds: readonly string[],
): Promise<Map<string, bigint>> {
  if (requestIds.length === 0) return new Map();
  const rows = await db
    .select({
      requestId: usage.requestId,
      cost: sql<string>`coalesce(sum(${usage.costMicroUsd}), 0)::text`,
    })
    .from(usage)
    .where(and(eq(usage.workspaceId, workspaceId), inArray(usage.requestId, [...requestIds])))
    .groupBy(usage.requestId);
  return new Map(rows.map((r) => [r.requestId, BigInt(r.cost)]));
}

/** Display names for principals, people and keys alike. */
export async function findPrincipalNames(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, { name: string; kind: 'user' | 'key' }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: principals.id, name: principals.displayName, kind: principals.kind })
    .from(principals)
    .where(inArray(principals.id, [...ids]));
  return new Map(rows.map((r) => [r.id, { name: r.name, kind: r.kind }]));
}
