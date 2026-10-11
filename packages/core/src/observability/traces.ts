import {
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  REFUSAL_CODES,
} from '@lakka/contracts';
import type {
  Principal,
  RequestListQuery,
  RequestListView,
  RequestOutcome,
  RequestSummaryView,
  SpanView,
  TraceView,
} from '@lakka/contracts';
import {
  countRequestRoots,
  findContinuedRequest,
  findPrincipalNames,
  listApprovalsForRequests,
  listRequestRoots,
  listRootsForRequests,
  listRouteNames,
  listSpanContentForRequest,
  listSpansForRequest,
  listUsageForRequest,
  sumRequestCosts,
} from '@lakka/db';
import type { ApprovalTraceRow, RequestFilter, SpanRow } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import { LK } from '../gateway/telemetry.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';

/*
 * Reading traces (OB-1, AC 16, ADR 0075 H1, ADR 0079). Everything is read within one workspace.
 * Workspace and instance admins see every request in it; members see only requests they made,
 * directly or through their keys, and anyone else's is not found. Keys read no traces:
 * troubleshooting is for people.
 *
 * A request that paused for a tool approval is read as one with the request that carried the
 * answer and ran on (ADR 0095): the list shows the first, with the chain's time and cost, and
 * its trace shows every step of both, with the wait between them.
 */

const DEFAULT_PAGE = 50;

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const number = (value: unknown) => (typeof value === 'number' ? value : null);

/** How many continuations one chain may have: more is a loop, not a conversation. */
const MAX_CHAIN = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const REFUSALS: ReadonlySet<string> = new Set(REFUSAL_CODES);

/** What became of one request, by the same rules the list filters with (ADR 0095). */
export function outcomeOf(
  row: Pick<SpanRow, 'status' | 'errorType' | 'attributes'>,
): RequestOutcome {
  if (row.status === 'error') {
    return row.errorType !== null && REFUSALS.has(row.errorType) ? 'refused' : 'failed';
  }
  const ended = text(row.attributes[LK.OUTCOME]);
  if (ended === 'interrupted') return 'failed';
  if (ended === 'aborted') return 'stopped';
  return text(row.attributes[LK.BUDGET_FALLBACK_MODEL]) === null ? 'completed' : 'cheaper';
}

/** The chain's outcome: how the first ended, unless a continuation failed or was stopped. */
function chainOutcome(rows: readonly SpanRow[]): RequestOutcome {
  const [first] = rows;
  if (first === undefined) return 'completed';
  const kinds = rows.map(outcomeOf);
  const firstKind = kinds[0] ?? 'completed';
  if (firstKind === 'refused' || firstKind === 'failed') return firstKind;
  const last = kinds.at(-1) ?? firstKind;
  if (last === 'failed' || last === 'stopped' || last === 'refused') return last;
  return kinds.includes('cheaper') ? 'cheaper' : 'completed';
}

/**
 * Each request with the requests that continued it after approvals, in order: approvals point
 * from the request that asked to the one that answered.
 */
async function chainsOf(
  ctx: ServiceContext,
  workspaceId: string,
  firstIds: readonly string[],
): Promise<{ chains: Map<string, string[]>; approvals: ApprovalTraceRow[] }> {
  const chains = new Map(firstIds.map((id) => [id, [id]]));
  const tailOf = new Map(firstIds.map((id) => [id, id]));
  const approvals: ApprovalTraceRow[] = [];
  let frontier = [...firstIds];
  for (let depth = 0; depth < MAX_CHAIN && frontier.length > 0; depth += 1) {
    const found = await listApprovalsForRequests(ctx.db, workspaceId, frontier);
    approvals.push(...found);
    const next: string[] = [];
    for (const a of found) {
      if (a.continuedByRequestId === null) continue;
      const first = tailOf.get(a.requestId);
      const chain = first === undefined ? undefined : chains.get(first);
      if (first === undefined || chain === undefined || chain.includes(a.continuedByRequestId)) {
        continue;
      }
      chain.push(a.continuedByRequestId);
      tailOf.set(a.continuedByRequestId, first);
      next.push(a.continuedByRequestId);
    }
    frontier = next;
  }
  return { chains, approvals };
}

/** Whether the caller sees the whole workspace, or only their own requests. */
async function access(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
): Promise<{ actingUserId?: string }> {
  if (principal.kind === 'key') throw new ForbiddenError('traces are read by people, not keys');
  const { role } = await authorizeWorkspaceAction(ctx, principal, workspaceId, 'workspace.read');
  const admin = role === 'admin' || principal.isInstanceAdmin;
  return admin ? {} : { actingUserId: principal.actingUserId };
}

async function summaries(
  ctx: ServiceContext,
  workspaceId: string,
  roots: readonly SpanRow[],
): Promise<RequestSummaryView[]> {
  const firstIds = roots.flatMap((r) => (r.requestId === null ? [] : [r.requestId]));
  const { chains, approvals } = await chainsOf(ctx, workspaceId, firstIds);
  const later = [...chains.values()].flatMap((chain) => chain.slice(1));
  const laterRoots = await listRootsForRequests(ctx.db, workspaceId, later);
  const rootOf = new Map(
    [...roots, ...laterRoots].flatMap((r) => (r.requestId === null ? [] : [[r.requestId, r]])),
  );
  const people = new Set<string>();
  const routeIds = new Set<string>();
  for (const r of roots) {
    for (const key of [LK.PRINCIPAL_ID, LK.ACTING_USER_ID]) {
      const id = text(r.attributes[key]);
      if (id !== null) people.add(id);
    }
    const route = text(r.attributes[LK.ROUTING_ROUTE_ID]);
    if (route !== null) routeIds.add(route);
  }
  const [costs, names, routeNames] = await Promise.all([
    sumRequestCosts(ctx.db, workspaceId, [...firstIds, ...later]),
    findPrincipalNames(ctx.db, [...people]),
    listRouteNames(ctx.db, workspaceId, [...routeIds]),
  ]);
  return roots.map((r) => {
    const principalId = text(r.attributes[LK.PRINCIPAL_ID]);
    const personId = text(r.attributes[LK.ACTING_USER_ID]);
    const principal = principalId === null ? undefined : names.get(principalId);
    const person = personId === null ? undefined : names.get(personId);
    const chainIds = chains.get(r.requestId ?? '') ?? [];
    const chain = chainIds.flatMap((id) => {
      const row = rootOf.get(id);
      return row === undefined ? [] : [row];
    });
    const last = chain.at(-1) ?? r;
    const end = Math.max(...chain.map((c) => c.startedAt.getTime() + c.durationMs));
    const cost = chainIds.reduce((sum, id) => sum + (costs.get(id) ?? 0n), 0n);
    const routeId = text(r.attributes[LK.ROUTING_ROUTE_ID]);
    const scope = text(r.attributes[LK.BUDGET_SCOPE]);
    const remaining = number(r.attributes[LK.BUDGET_REMAINING_MICRO_USD]);
    const failed = chain.toReversed().find((c) => c.status === 'error');
    return {
      requestId: r.requestId ?? '',
      traceId: r.traceId,
      startedAt: r.startedAt.toISOString(),
      durationMs: chain.length > 1 ? end - r.startedAt.getTime() : r.durationMs,
      status: chain.some((c) => c.status === 'error') ? 'error' : 'ok',
      errorType: failed?.errorType ?? r.errorType,
      surface: text(r.attributes[LK.SURFACE]),
      model: text(last.attributes[LK.MODEL]) ?? text(r.attributes[LK.MODEL]),
      outcome: text(last.attributes[LK.OUTCOME]),
      principal:
        principalId === null || principal === undefined
          ? null
          : { id: principalId, name: principal.name, kind: principal.kind },
      person:
        personId === null || person === undefined ? null : { id: personId, name: person.name },
      conversationId: text(r.attributes[LK.CONVERSATION_ID]),
      costMicroUsd: String(cost),
      outcomeKind: chainOutcome(chain.length === 0 ? [r] : chain),
      decision: {
        requested: text(r.attributes[LK.ROUTING_REQUESTED]),
        rule: text(r.attributes[LK.ROUTING_RULE]),
        route: routeId === null ? null : { id: routeId, name: routeNames.get(routeId) ?? null },
        confidence: number(r.attributes[LK.ROUTING_CONFIDENCE]),
        threshold: number(r.attributes[LK.ROUTING_THRESHOLD]),
        reason: text(r.attributes[LK.ROUTING_DEFAULT_REASON]),
      },
      budget:
        scope === 'instance' || scope === 'workspace' || scope === 'member' || scope === 'key'
          ? {
              scope,
              remainingMicroUsd: remaining === null ? null : String(Math.round(remaining)),
              from: text(r.attributes[LK.BUDGET_FALLBACK_FROM]),
              to: text(r.attributes[LK.BUDGET_FALLBACK_MODEL]),
            }
          : null,
      provider: failed === undefined ? null : text(failed.attributes[LK.PROVIDER]),
      toolDenied: approvals.some((a) => a.status === 'denied' && chainIds.includes(a.requestId)),
    };
  });
}

/** A cursor as the list hands it out: the last row's start and span id. */
const cursorOf = (row: SpanRow) => `${row.startedAt.toISOString()}|${row.spanId}`;

function parseCursor(cursor: string): { at: Date; spanId: string } {
  const [at = '', spanId = ''] = cursor.split('|');
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw new InvalidRequestError('before: not a cursor');
  return { at: date, spanId };
}

export async function listRequests(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  query: RequestListQuery,
): Promise<RequestListView> {
  const scope = await access(ctx, principal, workspaceId);
  const limit = query.limit ?? DEFAULT_PAGE;
  const from = query.from === undefined ? undefined : new Date(`${query.from}T00:00:00Z`);
  const until =
    query.to === undefined ? undefined : new Date(Date.parse(`${query.to}T00:00:00Z`) + DAY_MS);
  if (from !== undefined && until !== undefined && until <= from) {
    throw new InvalidRequestError('to: must not be before from');
  }
  // A member reads only their own, whoever they name (AC 16).
  const person = scope.actingUserId ?? query.person;
  const filter: RequestFilter = {
    workspaceId,
    ...(person === undefined ? {} : { actingUserId: person }),
    ...(query.surface === undefined ? {} : { surface: query.surface }),
    ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
    ...(from === undefined ? {} : { from }),
    ...(until === undefined ? {} : { until }),
  };
  const [roots, total] = await Promise.all([
    listRequestRoots(ctx.db, {
      ...filter,
      limit,
      ...(query.before === undefined ? {} : { before: parseCursor(query.before) }),
    }),
    countRequestRoots(ctx.db, filter),
  ]);
  const last = roots.at(-1);
  return {
    requests: await summaries(ctx, workspaceId, roots),
    nextBefore: roots.length === limit && last !== undefined ? cursorOf(last) : null,
    total,
  };
}

/** The spans in tree order: each parent before its children, children by start time. */
function inTreeOrder(rows: readonly SpanRow[], root: SpanRow): SpanView[] {
  const known = new Set(rows.map((r) => r.spanId));
  const children = new Map<string, SpanRow[]>();
  for (const r of rows) {
    if (r === root) continue;
    // A span whose parent was not stored hangs from the root, so nothing is lost.
    const parent =
      r.parentSpanId !== null && known.has(r.parentSpanId) ? r.parentSpanId : root.spanId;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const start = root.startedAt.getTime();
  const out: SpanView[] = [];
  const visit = (span: SpanRow, depth: number) => {
    out.push({
      spanId: span.spanId,
      requestId: span.requestId,
      parentSpanId: span.parentSpanId,
      depth,
      name: span.name,
      kind: span.kind,
      status: span.status,
      errorType: span.errorType,
      offsetMs: Math.max(0, span.startedAt.getTime() - start),
      durationMs: span.durationMs,
      attributes: span.attributes,
      events: span.events,
    });
    const kids = (children.get(span.spanId) ?? []).toSorted(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    );
    for (const kid of kids) visit(kid, depth + 1);
  };
  visit(root, 0);
  return out;
}

const missing = () => new NotFoundError('request not found');

export async function getRequestTrace(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  requestId: string,
): Promise<TraceView> {
  const scope = await access(ctx, principal, workspaceId);
  // A request that continued another is read as part of the first (ADR 0095).
  let firstId = requestId;
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    const previous = await findContinuedRequest(ctx.db, workspaceId, firstId);
    if (previous === undefined) break;
    firstId = previous;
  }
  const firstRows = await listSpansForRequest(ctx.db, workspaceId, firstId);
  const root = firstRows.find((r) => r.name === 'request' && r.parentSpanId === null);
  if (root === undefined) throw missing();
  // A member asking for someone else's request finds nothing (AC 16).
  if (
    scope.actingUserId !== undefined &&
    text(root.attributes[LK.ACTING_USER_ID]) !== scope.actingUserId
  ) {
    throw missing();
  }
  const { chains, approvals } = await chainsOf(ctx, workspaceId, [firstId]);
  const chain = chains.get(firstId) ?? [firstId];
  const later = await Promise.all(
    chain.slice(1).map((id) => listSpansForRequest(ctx.db, workspaceId, id)),
  );
  // A continuation's own request span is left out; its steps hang from the first request.
  const rows = [
    ...firstRows,
    ...later.flat().filter((r) => !(r.name === 'request' && r.parentSpanId === null)),
  ];
  const [[request], attemptsByRequest, contentByRequest] = await Promise.all([
    summaries(ctx, workspaceId, [root]),
    Promise.all(chain.map((id) => listUsageForRequest(ctx.db, workspaceId, id))),
    Promise.all(chain.map((id) => listSpanContentForRequest(ctx.db, workspaceId, id))),
  ]);
  if (request === undefined) throw missing();
  const routeIds = new Set(
    rows.flatMap((r) => {
      const id = text(r.attributes[LK.ROUTING_ROUTE_ID]);
      return id === null ? [] : [id];
    }),
  );
  const deciders = approvals.flatMap((a) =>
    a.decidedByPrincipalId === null ? [] : [a.decidedByPrincipalId],
  );
  const [routeNames, names] = await Promise.all([
    listRouteNames(ctx.db, workspaceId, [...routeIds]),
    findPrincipalNames(ctx.db, deciders),
  ]);
  const start = root.startedAt.getTime();
  return {
    request,
    spans: inTreeOrder(rows, root),
    attempts: attemptsByRequest.flat().map((a) => ({
      requestId: a.requestId,
      attempt: a.attempt,
      model: a.model,
      provider: a.provider,
      outcome: a.outcome,
      finishReason: a.finishReason,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      costMicroUsd: String(a.costMicroUsd),
      latencyMs: a.latencyMs,
      ttftMs: a.ttftMs,
    })),
    approvals: approvals.map((a) => {
      const by = a.decidedByPrincipalId === null ? undefined : names.get(a.decidedByPrincipalId);
      return {
        approvalId: a.id,
        toolName: a.toolName,
        status: a.status,
        always: a.always,
        askedOffsetMs: Math.max(0, a.createdAt.getTime() - start),
        answeredOffsetMs: a.decidedAt === null ? null : Math.max(0, a.decidedAt.getTime() - start),
        answeredBy:
          a.decidedByPrincipalId === null || by === undefined
            ? null
            : { id: a.decidedByPrincipalId, name: by.name },
      };
    }),
    content: contentByRequest.flat().map((c) => ({
      spanId: c.spanId,
      prompt: c.prompt,
      response: c.response,
      expiresAt: c.expiresAt.toISOString(),
    })),
    routes: [...routeNames].map(([id, name]) => ({ id, name })),
  };
}
