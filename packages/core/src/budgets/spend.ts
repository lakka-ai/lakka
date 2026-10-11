import { ForbiddenError, InvalidRequestError, MAX_SPEND_DAYS } from '@lakka/contracts';
import type { BudgetView, Principal, SpendQuery, SpendReport } from '@lakka/contracts';
import { listWorkspaceCaps, listWorkspaceIds, summarizeSpend } from '@lakka/db';
import type { SpendGroup, SpendTotals } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import { modelNames } from '../models/service.ts';
import { budgetViews } from './service.ts';
import type { ModelsContext } from '../models/service.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';

/*
 * The spend view (BG-11, F5, ADR 0055). Instance admins see the whole instance; workspace admins
 * see their workspace; members see their own spend in it, requests through their keys included.
 * Keys see none of it. Models are named for people, as chat names them (CH-2).
 */

/** Spend needs the catalogue as well, to name models. */
export type SpendContext = ServiceContext & ModelsContext;

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The requested whole UTC days, or the current month so far. */
export function spendRange(query: SpendQuery, now: Date): { from: Date; until: Date } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from =
    query.from === undefined
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : new Date(`${query.from}T00:00:00Z`);
  const to = query.to === undefined ? today : new Date(`${query.to}T00:00:00Z`);
  if (to < from) throw new InvalidRequestError('to: must not be before from');
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_SPEND_DAYS) {
    throw new InvalidRequestError(`a report covers at most ${MAX_SPEND_DAYS} days`);
  }
  return { from, until: new Date(to.getTime() + DAY_MS) };
}

const row = (g: SpendGroup) => ({
  key: g.key,
  label: g.label,
  costMicroUsd: String(g.costMicroUsd),
  requests: g.requests,
});

async function report(
  ctx: SpendContext,
  scope: SpendReport['scope'],
  range: { from: Date; until: Date },
  totals: SpendTotals,
  caps: readonly BudgetView[] = [],
): Promise<SpendReport> {
  const capOf = new Map(caps.map((c) => [c.workspaceId, c]));
  const names = await modelNames(ctx, [
    ...totals.byModel.map((m) => m.key),
    ...totals.speedByModel.map((m) => m.model),
    ...totals.byRoute.flatMap((r) => (r.model === null ? [] : [r.model])),
  ]);
  const name = (ref: string) => names.get(ref) ?? ref;
  const byDay = new Map(totals.byDay.map((d) => [d.day, d]));
  const days: SpendReport['byDay'] = [];
  for (let t = range.from.getTime(); t < range.until.getTime(); t += DAY_MS) {
    const date = isoDay(new Date(t));
    const found = byDay.get(date);
    days.push({
      date,
      costMicroUsd: String(found?.costMicroUsd ?? 0n),
      requests: found?.requests ?? 0,
    });
  }
  return {
    scope,
    from: isoDay(range.from),
    to: isoDay(new Date(range.until.getTime() - DAY_MS)),
    totalMicroUsd: String(totals.costMicroUsd),
    requests: totals.requests,
    downgradedRequests: totals.downgradedRequests,
    downgradedMicroUsd: String(totals.downgradedMicroUsd),
    byWorkspace: totals.byWorkspace.map((w) => ({
      ...row(w),
      deleted: w.deleted,
      cap: capOf.get(w.key) ?? null,
    })),
    byPerson: totals.byPerson.map((p) => ({ ...row(p), kind: p.kind, owner: p.owner })),
    byModel: totals.byModel.map((m) => ({ ...row(m), label: name(m.key) })),
    byDay: days,
    bySurface: totals.bySurface.map(row),
    byRoute: totals.byRoute.map((r) => ({
      ...row(r),
      kind: r.kind,
      model: r.model,
      modelName: r.model === null ? null : name(r.model),
    })),
    latency: totals.latency,
    tokens: totals.tokens,
    deniedRequests: totals.deniedRequests,
    refusals: totals.refusals,
    tools: totals.tools,
    toolCallsRan: totals.toolCallsRan,
    toolCallsNotAllowed: totals.toolCallsNotAllowed,
    toolCallsDenied: totals.toolCallsDenied,
    speedByModel: totals.speedByModel.map((m) => ({ ...m, name: name(m.model) })),
  };
}

export async function getInstanceSpend(
  ctx: SpendContext,
  principal: Principal,
  query: SpendQuery,
  now: Date = new Date(),
): Promise<SpendReport> {
  if (principal.kind !== 'user' || !principal.isInstanceAdmin) {
    throw new ForbiddenError('only instance admins see spend across the instance');
  }
  const range = spendRange(query, now);
  const [workspaceIds, capRows] = await Promise.all([
    listWorkspaceIds(ctx.db),
    listWorkspaceCaps(ctx.db),
  ]);
  const totals = await summarizeSpend(ctx.db, { workspaceIds, ...range });
  return report(ctx, 'instance', range, totals, await budgetViews(ctx, capRows, now));
}

export async function getWorkspaceSpend(
  ctx: SpendContext,
  principal: Principal,
  workspaceId: string,
  query: SpendQuery,
  now: Date = new Date(),
): Promise<SpendReport> {
  const { role } = await authorizeWorkspaceAction(ctx, principal, workspaceId, 'budgets.read');
  const range = spendRange(query, now);
  const isAdmin = role === 'admin' || (principal.kind === 'user' && principal.isInstanceAdmin);
  const totals = await summarizeSpend(ctx.db, {
    workspaceIds: [workspaceId],
    ...(isAdmin ? {} : { actingUserId: principal.actingUserId }),
    ...range,
  });
  return report(ctx, isAdmin ? 'workspace' : 'own', range, totals);
}
