import { ForbiddenError, NotFoundError, periodEnd, periodStart } from '@lakka/contracts';
import type {
  AppliedCapView,
  BudgetBody,
  BudgetStatusView,
  BudgetView,
  Principal,
  RemainingBudgetView,
  WorkspaceBudgetsView,
} from '@lakka/contracts';
import {
  deleteBudget,
  findBudget,
  findKey,
  findMembership,
  findSpend,
  listBudgetsForWorkspace,
  listKeys,
  setBudget,
  spendSince,
} from '@lakka/db';
import type { BudgetRow, BudgetTarget, KeyRow } from '@lakka/db';
import type { ServiceContext } from '../context.ts';
import { authorizeWorkspaceAction } from '../workspaces/service.ts';

/*
 * Managing budgets (BG-1, BG-9, Q1, ADR 0049):
 *
 * - instance admins set the instance cap and each workspace's cap, so no workspace raises its own
 *   ceiling;
 * - workspace admins set member and key caps inside their workspace;
 * - a key's owner may cap their own key, and may lower, but not raise or remove, a cap an admin
 *   put on it. A cap the owner set themselves they may change freely;
 * - members see their own caps and their keys' caps; admins see every cap in the workspace.
 *
 * Keys manage no budgets at all: a leaked key must not be able to lift its own limit.
 */

const instanceAdminOnly = () => new ForbiddenError('only instance admins set this budget');

function requireInstanceAdmin(principal: Principal): void {
  if (principal.kind !== 'user' || !principal.isInstanceAdmin) throw instanceAdminOnly();
}

function value(body: BudgetBody) {
  return {
    limitMicroUsd: BigInt(body.limitMicroUsd),
    period: body.period,
    alertPercents: body.alertPercents.toSorted((a, b) => a - b),
  };
}

/** Budgets as the api shows them, with what was spent in each one's current period. */
export async function budgetViews(
  ctx: ServiceContext,
  rows: readonly BudgetRow[],
  now: Date,
): Promise<BudgetView[]> {
  const starts = rows.map((r) => ({ budgetId: r.id, periodStart: periodStart(r.period, now) }));
  const spent = await findSpend(ctx.db, starts);
  return rows.map((r, i) => {
    // starts has one entry per row, in the same order.
    const start = (starts[i] as { periodStart: Date }).periodStart;
    return {
      id: r.id,
      scope: r.scope,
      workspaceId: r.workspaceId,
      principalId: r.principalId,
      name: r.scope === 'member' || r.scope === 'key' ? r.name : null,
      keyId: r.scope === 'key' ? r.keyId : null,
      limitMicroUsd: String(r.limitMicroUsd),
      period: r.period,
      alertPercents: r.alertPercents,
      periodStart: start.toISOString(),
      periodEnd: periodEnd(r.period, start)?.toISOString() ?? null,
      spentMicroUsd: String(spent.get(r.id) ?? 0n),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

async function view(ctx: ServiceContext, row: BudgetRow, now = new Date()): Promise<BudgetView> {
  const [result] = await budgetViews(ctx, [row], now);
  // views returns one view per row.
  return result as BudgetView;
}

export async function getInstanceBudget(
  ctx: ServiceContext,
  principal: Principal,
): Promise<BudgetView | null> {
  requireInstanceAdmin(principal);
  const row = await findBudget(ctx.db, { scope: 'instance' });
  return row === undefined ? null : view(ctx, row);
}

export async function setInstanceBudget(
  ctx: ServiceContext,
  principal: Principal,
  body: BudgetBody,
): Promise<BudgetView> {
  requireInstanceAdmin(principal);
  return view(ctx, await setBudget(ctx.db, { scope: 'instance' }, value(body), principal.id));
}

export async function removeInstanceBudget(
  ctx: ServiceContext,
  principal: Principal,
): Promise<void> {
  requireInstanceAdmin(principal);
  if (!(await deleteBudget(ctx.db, { scope: 'instance' }))) {
    throw new NotFoundError('no instance budget');
  }
}

export async function listBudgets(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  now: Date = new Date(),
): Promise<WorkspaceBudgetsView> {
  const { role } = await authorizeWorkspaceAction(ctx, principal, workspaceId, 'budgets.read');
  const isAdmin = role === 'admin' || (principal.kind === 'user' && principal.isInstanceAdmin);
  const rows = await listBudgetsForWorkspace(ctx.db, workspaceId);
  const ownKeys = isAdmin
    ? new Set<string>()
    : new Set(
        (await listKeys(ctx.db, workspaceId, principal.actingUserId)).map((k) => k.principalId),
      );
  // A member sees their own cap and the caps on keys they own.
  const visible = rows.filter(
    (r) =>
      isAdmin ||
      (r.scope === 'member' && r.principalId === principal.actingUserId) ||
      (r.scope === 'key' && r.principalId !== null && ownKeys.has(r.principalId)),
  );
  const all = await budgetViews(ctx, visible, now);
  const monthSpend = (await spendSince(ctx.db, workspaceId, periodStart('monthly', now))).filter(
    (r) =>
      isAdmin ||
      (r.keyId === null ? r.principalId === principal.actingUserId : ownKeys.has(r.principalId)),
  );
  return {
    instance: all.find((b) => b.scope === 'instance') ?? null,
    workspace: all.find((b) => b.scope === 'workspace') ?? null,
    members: all.filter((b) => b.scope === 'member'),
    keys: all.filter((b) => b.scope === 'key'),
    monthSpend: monthSpend.map((r) => ({ ...r, spentMicroUsd: String(r.spentMicroUsd) })),
  };
}

/**
 * Whether budgets can be checked (BG-4), by asking the store that holds reservations. `ping`
 * resolves when it answers and rejects or times out when it does not.
 */
export async function budgetStatus(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  ping: () => Promise<unknown>,
): Promise<BudgetStatusView> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'budgets.read');
  try {
    await ping();
    return { available: true };
  } catch {
    return { available: false };
  }
}

/** The meter turns low at 20 percent left, or earlier when the first alert is (CH-4). */
const LOW_PERCENT_LEFT = 20;

/** Narrowest first, so of two caps with the same headroom the more personal one is named. */
const NARROWEST: Readonly<Record<BudgetView['scope'], number>> = {
  key: 0,
  member: 1,
  workspace: 2,
  instance: 3,
};

/**
 * What a person can still spend here (CH-4, ADR 0061): the least headroom among the caps their
 * own requests count against, the chain a reservation takes (instance, workspace, member). Keys
 * read no budgets, like the rest of this service. Settled spend only: a request in flight is not
 * subtracted until it settles. Null when no cap applies.
 */
export async function remainingBudget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  now: Date = new Date(),
): Promise<RemainingBudgetView | null> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'budgets.read');
  const rows = (await listBudgetsForWorkspace(ctx.db, workspaceId)).filter(
    (r) =>
      r.scope === 'instance' ||
      r.scope === 'workspace' ||
      (r.scope === 'member' && r.principalId === principal.actingUserId),
  );
  let tightest: { cap: BudgetView; remaining: bigint } | null = null;
  const caps: AppliedCapView[] = [];
  for (const cap of await budgetViews(ctx, rows, now)) {
    const left = BigInt(cap.limitMicroUsd) - BigInt(cap.spentMicroUsd);
    const remaining = left > 0n ? left : 0n;
    caps.push({
      scope: cap.scope,
      limitMicroUsd: cap.limitMicroUsd,
      remainingMicroUsd: String(remaining),
      period: cap.period,
      periodEnd: cap.periodEnd,
      lowAtPercentLeft: Math.max(
        LOW_PERCENT_LEFT,
        cap.alertPercents.length === 0 ? 0 : 100 - Math.min(...cap.alertPercents),
      ),
    });
    if (
      tightest === null ||
      remaining < tightest.remaining ||
      (remaining === tightest.remaining && NARROWEST[cap.scope] < NARROWEST[tightest.cap.scope])
    ) {
      tightest = { cap, remaining };
    }
  }
  return tightest === null
    ? null
    : {
        remainingMicroUsd: String(tightest.remaining),
        scope: tightest.cap.scope,
        periodEnd: tightest.cap.periodEnd,
        caps: caps.toSorted((a, b) => NARROWEST[a.scope] - NARROWEST[b.scope]),
      };
}

/** The workspace cap: instance admins only. Others learn only whether the workspace exists. */
async function workspaceTarget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
): Promise<BudgetTarget> {
  // Non-members are told the workspace does not exist before anyone is told they may not.
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'workspace.read');
  requireInstanceAdmin(principal);
  return { scope: 'workspace', workspaceId };
}

export async function setWorkspaceBudget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  body: BudgetBody,
): Promise<BudgetView> {
  const target = await workspaceTarget(ctx, principal, workspaceId);
  return view(ctx, await setBudget(ctx.db, target, value(body), principal.id));
}

export async function removeWorkspaceBudget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
): Promise<void> {
  const target = await workspaceTarget(ctx, principal, workspaceId);
  if (!(await deleteBudget(ctx.db, target))) throw new NotFoundError('no workspace budget');
}

async function memberTarget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  memberId: string,
): Promise<BudgetTarget> {
  await authorizeWorkspaceAction(ctx, principal, workspaceId, 'budgets.manage');
  if ((await findMembership(ctx.db, workspaceId, memberId)) === undefined) {
    throw new NotFoundError('not a member of this workspace');
  }
  return { scope: 'member', workspaceId, principalId: memberId };
}

export async function setMemberBudget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  memberId: string,
  body: BudgetBody,
): Promise<BudgetView> {
  const target = await memberTarget(ctx, principal, workspaceId, memberId);
  return view(ctx, await setBudget(ctx.db, target, value(body), principal.id));
}

export async function removeMemberBudget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  memberId: string,
): Promise<void> {
  const target = await memberTarget(ctx, principal, workspaceId, memberId);
  if (!(await deleteBudget(ctx.db, target))) throw new NotFoundError('no budget for this member');
}

/**
 * Who may change a key's cap, and how: an admin freely; its owner freely if they set the current
 * cap (or there is none), and otherwise only downwards within the same period.
 */
async function keyTarget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  keyId: string,
  change: { limitMicroUsd: bigint; period: BudgetBody['period'] } | 'remove',
): Promise<BudgetTarget> {
  const { role } = await authorizeWorkspaceAction(ctx, principal, workspaceId, 'budgets.read');
  const key: KeyRow | undefined = await findKey(ctx.db, workspaceId, keyId);
  if (key === undefined) throw new NotFoundError('key not found');
  const target: BudgetTarget = { scope: 'key', workspaceId, principalId: key.principalId };
  const isAdmin = role === 'admin' || (principal.kind === 'user' && principal.isInstanceAdmin);
  if (isAdmin) return target;
  if (key.ownerPrincipalId !== principal.actingUserId) throw new NotFoundError('key not found');
  const current = await findBudget(ctx.db, target);
  if (current === undefined || current.updatedByPrincipalId === principal.id) return target;
  if (
    change !== 'remove' &&
    change.period === current.period &&
    change.limitMicroUsd <= current.limitMicroUsd
  ) {
    return target;
  }
  throw new ForbiddenError('an admin set this cap; you can only lower it');
}

export async function setKeyBudget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  keyId: string,
  body: BudgetBody,
): Promise<BudgetView> {
  const change = value(body);
  const target = await keyTarget(ctx, principal, workspaceId, keyId, change);
  return view(ctx, await setBudget(ctx.db, target, change, principal.id));
}

export async function removeKeyBudget(
  ctx: ServiceContext,
  principal: Principal,
  workspaceId: string,
  keyId: string,
): Promise<void> {
  const target = await keyTarget(ctx, principal, workspaceId, keyId, 'remove');
  if (!(await deleteBudget(ctx.db, target))) throw new NotFoundError('no budget for this key');
}
