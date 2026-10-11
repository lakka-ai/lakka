import { and, desc, eq, gte, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { REFUSAL_CODES } from '@lakka/contracts';
import type { RefusalCode, SpendRouteKind } from '@lakka/contracts';
import type { Db } from '../client.ts';
import { reservations } from '../schema/budgets.ts';
import { principals, workspaces } from '../schema/identity.ts';
import { toolApprovals, toolInvocations } from '../schema/mcp.ts';
import { spans } from '../schema/observability.ts';
import { routes } from '../schema/routing.ts';
import { usage } from '../schema/usage.ts';

/*
 * Spend, read from usage records (BG-11, ADR 0055). Always scoped: to an explicit list of
 * workspaces, and optionally to one person's spend (their own requests and their keys'). Counts
 * are requests, not attempts; costs include every attempt, since each was paid for.
 */

export interface SpendFilter {
  workspaceIds: readonly string[];
  /** Only this person's spend: requests they made, directly or through their keys. */
  actingUserId?: string;
  from: Date;
  /** Exclusive. */
  until: Date;
}

export interface SpendGroup {
  key: string;
  label: string;
  costMicroUsd: bigint;
  requests: number;
}

/** A person's own requests, or one key's, with the person a key acts for. */
export interface SpendPrincipalGroup extends SpendGroup {
  kind: 'user' | 'key';
  owner: { id: string; name: string } | null;
}

export interface SpendRouteGroup extends SpendGroup {
  kind: SpendRouteKind;
  /** For a route: the model it sends to now. */
  model: string | null;
}

export interface SpreadRow {
  p50: number;
  p95: number;
}

export interface ModelSpeedGroup {
  model: string;
  requests: number;
  latency: SpreadRow;
  timeToFirstToken: SpreadRow | null;
  inputTokens: SpreadRow;
  outputTokens: SpreadRow;
}

/** A workspace's spend; a deleted one's stays in the instance's records (ID-8). */
export interface SpendWorkspaceGroup extends SpendGroup {
  deleted: boolean;
}

export interface SpendTotals {
  costMicroUsd: bigint;
  requests: number;
  downgradedRequests: number;
  downgradedMicroUsd: bigint;
  byWorkspace: SpendWorkspaceGroup[];
  byPerson: SpendPrincipalGroup[];
  byModel: SpendGroup[];
  /** Days with spend, as UTC dates (YYYY-MM-DD). */
  byDay: { day: string; costMicroUsd: bigint; requests: number }[];
  bySurface: SpendGroup[];
  /** By how the model was picked: routes by id, the rest under their kind. */
  byRoute: SpendRouteGroup[];
  /** Over completed attempts, in milliseconds; null with none. */
  latency: { p50: number; p95: number } | null;
  /** The spread, not the average: context overflows happen in the tail. */
  tokens: { inputP50: number; inputP95: number; inputMax: number; outputP95: number } | null;
  /** Requests a cap refused outright (BG-7, the tech spec's metrics from day one). */
  deniedRequests: number;
  /** Root spans refused before anything was charged, by error code (OB-1). */
  refusals: { code: RefusalCode; requests: number }[];
  /** Tool calls by tool, and how many failed or were refused (TL-6). */
  tools: { name: string; calls: number; failed: number; refused: number }[];
  toolCallsRan: number;
  toolCallsNotAllowed: number;
  /** Approvals the person answered with a no (TL-4). */
  toolCallsDenied: number;
  speedByModel: ModelSpeedGroup[];
}

/** A percentile of a column, as Postgres computes it. */
const pct = (fraction: number, column: SQL) =>
  sql<number | null>`percentile_cont(${fraction}) within group (order by ${column})`;

const cost = sql<string>`coalesce(sum(${usage.costMicroUsd}), 0)::text`;
const requests = sql<number>`count(distinct ${usage.requestId})::int`;

const group = (r: { key: string; label: string; cost: string; requests: number }) => ({
  key: r.key,
  label: r.label,
  costMicroUsd: BigInt(r.cost),
  requests: r.requests,
});

/** Percentiles come back as numbers or numeric strings, and null only over no rows. */
const spreadOf = (p50: number | string | null, p95: number | string | null): SpreadRow => ({
  p50: Number(p50 ?? 0),
  p95: Number(p95 ?? 0),
});

export async function summarizeSpend(db: Db, filter: SpendFilter): Promise<SpendTotals> {
  if (filter.workspaceIds.length === 0) {
    return {
      costMicroUsd: 0n,
      requests: 0,
      downgradedRequests: 0,
      downgradedMicroUsd: 0n,
      byWorkspace: [],
      byPerson: [],
      byModel: [],
      byDay: [],
      bySurface: [],
      byRoute: [],
      latency: null,
      tokens: null,
      deniedRequests: 0,
      refusals: [],
      tools: [],
      toolCallsRan: 0,
      toolCallsNotAllowed: 0,
      toolCallsDenied: 0,
      speedByModel: [],
    };
  }
  const where: SQL | undefined = and(
    inArray(usage.workspaceId, [...filter.workspaceIds]),
    gte(usage.createdAt, filter.from),
    lt(usage.createdAt, filter.until),
    filter.actingUserId === undefined ? undefined : eq(usage.actingUserId, filter.actingUserId),
  );
  const owners = alias(principals, 'owners');
  const day = sql<string>`to_char(${usage.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const inRange = (column: typeof reservations.createdAt | typeof toolInvocations.createdAt) =>
    and(gte(column, filter.from), lt(column, filter.until));
  const denials = db
    .select({ requests: sql<number>`count(distinct ${reservations.requestId})::int` })
    .from(reservations)
    .where(
      and(
        inArray(reservations.workspaceId, [...filter.workspaceIds]),
        eq(reservations.state, 'denied'),
        inRange(reservations.createdAt),
        filter.actingUserId === undefined
          ? undefined
          : eq(reservations.actingUserId, filter.actingUserId),
      ),
    );
  const tools = db
    .select({
      name: toolInvocations.toolName,
      calls: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${toolInvocations.status} in ('failed', 'timeout'))::int`,
      refused: sql<number>`count(*) filter (where ${toolInvocations.status} in ('rejected', 'denied'))::int`,
    })
    .from(toolInvocations)
    .where(
      and(
        inArray(toolInvocations.workspaceId, [...filter.workspaceIds]),
        inRange(toolInvocations.createdAt),
        filter.actingUserId === undefined
          ? undefined
          : eq(toolInvocations.actingUserId, filter.actingUserId),
      ),
    )
    .groupBy(toolInvocations.toolName)
    .orderBy(desc(sql`count(*)`));
  const toolCounts = db
    .select({
      ran: sql<number>`count(*) filter (where ${toolInvocations.status} in ('ok', 'failed', 'timeout'))::int`,
      notAllowed: sql<number>`count(*) filter (where ${toolInvocations.status} = 'denied')::int`,
    })
    .from(toolInvocations)
    .where(
      and(
        inArray(toolInvocations.workspaceId, [...filter.workspaceIds]),
        inRange(toolInvocations.createdAt),
        filter.actingUserId === undefined
          ? undefined
          : eq(toolInvocations.actingUserId, filter.actingUserId),
      ),
    );
  // An approval is counted when it was answered; the call it asks about says whose it was.
  const denied = db
    .select({ calls: sql<number>`count(*)::int` })
    .from(toolApprovals)
    .innerJoin(toolInvocations, eq(toolInvocations.id, toolApprovals.toolInvocationId))
    .where(
      and(
        inArray(toolApprovals.workspaceId, [...filter.workspaceIds]),
        eq(toolApprovals.status, 'denied'),
        gte(toolApprovals.decidedAt, filter.from),
        lt(toolApprovals.decidedAt, filter.until),
        filter.actingUserId === undefined
          ? undefined
          : eq(toolInvocations.actingUserId, filter.actingUserId),
      ),
    );
  const refusals = db
    .select({ code: spans.errorType, requests: sql<number>`count(*)::int` })
    .from(spans)
    .where(
      and(
        inArray(spans.workspaceId, [...filter.workspaceIds]),
        eq(spans.name, 'request'),
        gte(spans.startedAt, filter.from),
        lt(spans.startedAt, filter.until),
        eq(spans.status, 'error'),
        inArray(spans.errorType, [...REFUSAL_CODES]),
        filter.actingUserId === undefined
          ? undefined
          : sql`${spans.attributes}->>'lakka.acting_user_id' = ${filter.actingUserId}`,
      ),
    )
    .groupBy(spans.errorType)
    .orderBy(desc(sql`count(*)`), spans.errorType);
  const speed = db
    .select({
      model: usage.model,
      requests,
      latencyP50: pct(0.5, sql`${usage.latencyMs}`),
      latencyP95: pct(0.95, sql`${usage.latencyMs}`),
      ttftP50: pct(0.5, sql`${usage.ttftMs}`),
      ttftP95: pct(0.95, sql`${usage.ttftMs}`),
      inputP50: pct(0.5, sql`${usage.inputTokens}`),
      inputP95: pct(0.95, sql`${usage.inputTokens}`),
      outputP50: pct(0.5, sql`${usage.outputTokens}`),
      outputP95: pct(0.95, sql`${usage.outputTokens}`),
    })
    .from(usage)
    .where(and(where, eq(usage.outcome, 'completed')))
    .groupBy(usage.model)
    .orderBy(desc(requests), usage.model);
  // A person's choice counts as theirs even when it overrode a route, which the row also names.
  const routeKind = sql<SpendRouteKind>`case
    when ${usage.resolutionRule} = 'explicit' then 'chosen'
    when ${usage.resolutionRule} = 'pinned' then 'pinned'
    when ${usage.routeId} is not null then 'route'
    else 'default' end`;
  const spread = db
    .select({
      latencyP50: pct(0.5, sql`${usage.latencyMs}`),
      latencyP95: pct(0.95, sql`${usage.latencyMs}`),
      inputP50: pct(0.5, sql`${usage.inputTokens}`),
      inputP95: pct(0.95, sql`${usage.inputTokens}`),
      inputMax: sql<number | null>`max(${usage.inputTokens})`,
      outputP95: pct(0.95, sql`${usage.outputTokens}`),
    })
    .from(usage)
    .where(and(where, eq(usage.outcome, 'completed')));
  const [extraDenied, extraTools, extraSpread, bySurface, byRoute] = await Promise.all([
    denials,
    tools,
    spread,
    db
      .select({ key: usage.surface, cost, requests })
      .from(usage)
      .where(where)
      .groupBy(usage.surface)
      .orderBy(desc(sql`sum(${usage.costMicroUsd})`)),
    db
      .select({
        kind: routeKind,
        routeId: routes.id,
        label: routes.name,
        model: routes.model,
        cost,
        requests,
      })
      .from(usage)
      .leftJoin(
        routes,
        and(eq(routes.id, usage.routeId), notInArray(usage.resolutionRule, ['explicit', 'pinned'])),
      )
      .where(where)
      .groupBy(routeKind, routes.id, routes.name, routes.model)
      .orderBy(desc(sql`sum(${usage.costMicroUsd})`)),
  ]);
  const [extraCounts, extraApprovals, extraRefusals, extraSpeed] = await Promise.all([
    toolCounts,
    denied,
    refusals,
    speed,
  ]);
  const [totals, downgraded, byWorkspace, byPerson, byModel, byDay] = await Promise.all([
    db.select({ cost, requests }).from(usage).where(where),
    db
      .select({ cost, requests })
      .from(usage)
      .where(and(where, isNotNull(usage.budgetFallbackFrom))),
    db
      .select({
        key: usage.workspaceId,
        label: workspaces.name,
        deleted: sql<boolean>`${workspaces.deletedAt} is not null`,
        cost,
        requests,
      })
      .from(usage)
      .innerJoin(workspaces, eq(workspaces.id, usage.workspaceId))
      .where(where)
      .groupBy(usage.workspaceId, workspaces.name, workspaces.deletedAt)
      .orderBy(desc(sql`sum(${usage.costMicroUsd})`)),
    db
      .select({
        key: usage.principalId,
        label: principals.displayName,
        kind: principals.kind,
        ownerId: owners.id,
        ownerName: owners.displayName,
        cost,
        requests,
      })
      .from(usage)
      .innerJoin(principals, eq(principals.id, usage.principalId))
      .leftJoin(owners, eq(owners.id, principals.ownerPrincipalId))
      .where(where)
      .groupBy(
        usage.principalId,
        principals.displayName,
        principals.kind,
        owners.id,
        owners.displayName,
      )
      .orderBy(desc(sql`sum(${usage.costMicroUsd})`)),
    db
      .select({ key: usage.model, cost, requests })
      .from(usage)
      .where(where)
      .groupBy(usage.model)
      .orderBy(desc(sql`sum(${usage.costMicroUsd})`)),
    db.select({ day, cost, requests }).from(usage).where(where).groupBy(day).orderBy(day),
  ]);
  return {
    costMicroUsd: BigInt(totals[0]?.cost ?? '0'),
    requests: totals[0]?.requests ?? 0,
    downgradedRequests: downgraded[0]?.requests ?? 0,
    downgradedMicroUsd: BigInt(downgraded[0]?.cost ?? '0'),
    byWorkspace: byWorkspace.map((r) => ({ ...group(r), deleted: r.deleted })),
    byPerson: byPerson.map((r) => ({
      ...group(r),
      kind: r.kind,
      owner: r.ownerId === null ? null : { id: r.ownerId, name: r.ownerName ?? '' },
    })),
    byModel: byModel.map((r) => group({ ...r, label: r.key })),
    byDay: byDay.map((r) => ({
      day: r.day,
      costMicroUsd: BigInt(r.cost),
      requests: r.requests,
    })),
    bySurface: bySurface.map((r) => group({ ...r, label: r.key })),
    byRoute: byRoute.map((r) => ({
      ...group({
        key: r.kind === 'route' && r.routeId !== null ? r.routeId : r.kind,
        label: r.label ?? '',
        cost: r.cost,
        requests: r.requests,
      }),
      kind: r.kind,
      model: r.model,
    })),
    latency:
      extraSpread[0]?.latencyP50 == null || extraSpread[0].latencyP95 == null
        ? null
        : { p50: Number(extraSpread[0].latencyP50), p95: Number(extraSpread[0].latencyP95) },
    tokens:
      extraSpread[0]?.inputP50 == null
        ? null
        : {
            inputP50: Number(extraSpread[0].inputP50),
            inputP95: Number(extraSpread[0].inputP95),
            inputMax: Number(extraSpread[0].inputMax),
            outputP95: Number(extraSpread[0].outputP95),
          },
    deniedRequests: extraDenied[0]?.requests ?? 0,
    refusals: extraRefusals.map((r) => ({ code: r.code as RefusalCode, requests: r.requests })),
    tools: extraTools,
    toolCallsRan: extraCounts[0]?.ran ?? 0,
    toolCallsNotAllowed: extraCounts[0]?.notAllowed ?? 0,
    toolCallsDenied: extraApprovals[0]?.calls ?? 0,
    speedByModel: extraSpeed.map((r) => ({
      model: r.model,
      requests: r.requests,
      latency: spreadOf(r.latencyP50, r.latencyP95),
      timeToFirstToken: r.ttftP50 === null ? null : spreadOf(r.ttftP50, r.ttftP95),
      inputTokens: spreadOf(r.inputP50, r.inputP95),
      outputTokens: spreadOf(r.outputP50, r.outputP95),
    })),
  };
}

/**
 * Every workspace's id, for the instance-wide report. Deleted ones too: their spend stays in the
 * instance's records (ID-8, ADR 0104).
 */
export async function listWorkspaceIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: workspaces.id }).from(workspaces);
  return rows.map((r) => r.id);
}
