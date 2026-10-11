import { and, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { BudgetPeriod, BudgetScope } from '@lakka/contracts';
import type { Db } from '../client.ts';
import { budgetSpend, budgets } from '../schema/budgets.ts';
import { apiKeys, principals, workspaces } from '../schema/identity.ts';
import { usage } from '../schema/usage.ts';

/*
 * Budget data access (BG-1, BG-9, ADR 0049). Workspace budgets are always read and written through
 * their workspace id; the instance budget is the one row with no workspace. Every write bumps
 * policy_version in the same transaction, so request snapshots pick up a new limit on their next
 * read: the instance cap applies to every workspace, so changing it bumps them all.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type BudgetTarget =
  | { scope: 'instance' }
  | { scope: 'workspace'; workspaceId: string }
  | { scope: 'member' | 'key'; workspaceId: string; principalId: string };

export interface BudgetRow {
  id: string;
  scope: BudgetScope;
  workspaceId: string | null;
  principalId: string | null;
  limitMicroUsd: bigint;
  period: BudgetPeriod;
  alertPercents: number[];
  updatedByPrincipalId: string;
  updatedAt: Date;
  /** The member's or key's display name. */
  name: string | null;
  /** For a key budget, its api_keys row. */
  keyId: string | null;
}

function targetWhere(target: BudgetTarget) {
  switch (target.scope) {
    case 'instance':
      return and(eq(budgets.scope, 'instance'), isNull(budgets.workspaceId));
    case 'workspace':
      return and(
        eq(budgets.scope, 'workspace'),
        eq(budgets.workspaceId, target.workspaceId),
        isNull(budgets.principalId),
      );
    default:
      return and(
        eq(budgets.scope, target.scope),
        eq(budgets.workspaceId, target.workspaceId),
        eq(budgets.principalId, target.principalId),
      );
  }
}

async function bumpVersions(tx: Tx, target: BudgetTarget): Promise<void> {
  await tx
    .update(workspaces)
    .set({ policyVersion: sql`${workspaces.policyVersion} + 1` })
    .where(target.scope === 'instance' ? undefined : eq(workspaces.id, target.workspaceId));
}

function selectBudgets(db: Db | Tx) {
  return db
    .select({
      id: budgets.id,
      scope: budgets.scope,
      workspaceId: budgets.workspaceId,
      principalId: budgets.principalId,
      limitMicroUsd: budgets.limitMicroUsd,
      period: budgets.period,
      alertPercents: budgets.alertPercents,
      updatedByPrincipalId: budgets.updatedByPrincipalId,
      updatedAt: budgets.updatedAt,
      name: principals.displayName,
      keyId: apiKeys.id,
    })
    .from(budgets)
    .leftJoin(principals, eq(principals.id, budgets.principalId))
    .leftJoin(apiKeys, eq(apiKeys.principalId, budgets.principalId));
}

export async function findBudget(db: Db, target: BudgetTarget): Promise<BudgetRow | undefined> {
  const [row] = await selectBudgets(db).where(targetWhere(target)).limit(1);
  return row;
}

/** Every budget inside the workspace, and the instance budget above it. */
export async function listBudgetsForWorkspace(db: Db, workspaceId: string): Promise<BudgetRow[]> {
  return selectBudgets(db).where(
    or(eq(budgets.workspaceId, workspaceId), eq(budgets.scope, 'instance')),
  );
}

/** Every workspace's own cap, for the instance spend view (ADR 0097). Instance admins only. */
export async function listWorkspaceCaps(db: Db): Promise<BudgetRow[]> {
  return selectBudgets(db).where(eq(budgets.scope, 'workspace'));
}

/** Creates or replaces the budget for a target. Returns it. */
export async function setBudget(
  db: Db,
  target: BudgetTarget,
  value: { limitMicroUsd: bigint; period: BudgetPeriod; alertPercents: number[] },
  updatedByPrincipalId: string,
): Promise<BudgetRow> {
  return db.transaction(async (tx) => {
    // One statement, so two admins setting the same cap at once cannot both insert.
    await tx
      .insert(budgets)
      .values({
        scope: target.scope,
        workspaceId: target.scope === 'instance' ? null : target.workspaceId,
        principalId:
          target.scope === 'member' || target.scope === 'key' ? target.principalId : null,
        limitMicroUsd: value.limitMicroUsd,
        period: value.period,
        alertPercents: value.alertPercents,
        updatedByPrincipalId,
      })
      .onConflictDoUpdate({
        target: [budgets.scope, budgets.workspaceId, budgets.principalId],
        set: { ...value, updatedByPrincipalId, updatedAt: sql`now()` },
      });
    await bumpVersions(tx, target);
    const [row] = await selectBudgets(tx).where(targetWhere(target)).limit(1);
    if (row === undefined) throw new Error('budget write returned nothing');
    return row;
  });
}

/** Removes the budget for a target; returns whether there was one. */
export async function deleteBudget(db: Db, target: BudgetTarget): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(budgets)
      .where(targetWhere(target))
      .returning({ id: budgets.id });
    if (deleted.length > 0) await bumpVersions(tx, target);
    return deleted.length > 0;
  });
}

/** Spend recorded for each budget in the given period; budgets with none are absent. */
export async function findSpend(
  db: Db,
  periods: readonly { budgetId: string; periodStart: Date }[],
): Promise<Map<string, bigint>> {
  if (periods.length === 0) return new Map();
  const rows = await db
    .select({
      budgetId: budgetSpend.budgetId,
      periodStart: budgetSpend.periodStart,
      spent: budgetSpend.spentMicroUsd,
    })
    .from(budgetSpend)
    .where(
      inArray(
        budgetSpend.budgetId,
        periods.map((p) => p.budgetId),
      ),
    );
  const wanted = new Map(periods.map((p) => [p.budgetId, p.periodStart.getTime()]));
  return new Map(
    rows
      .filter((r) => wanted.get(r.budgetId) === r.periodStart.getTime())
      .map((r) => [r.budgetId, r.spent]),
  );
}

/**
 * What each person and each key spent in a workspace since `since`, from usage, capped or not: a
 * person's through their keys included, as their cap counts it, and each key's own. Only those
 * with spend are listed.
 */
export async function spendSince(
  db: Db,
  workspaceId: string,
  since: Date,
): Promise<{ principalId: string; keyId: string | null; spentMicroUsd: bigint }[]> {
  const inWorkspace = and(eq(usage.workspaceId, workspaceId), gte(usage.createdAt, since));
  const cost = sql<string>`sum(${usage.costMicroUsd})::text`;
  const [people, keys] = await Promise.all([
    db
      .select({ principalId: usage.actingUserId, cost })
      .from(usage)
      .where(inWorkspace)
      .groupBy(usage.actingUserId),
    db
      .select({ principalId: usage.principalId, keyId: apiKeys.id, cost })
      .from(usage)
      .innerJoin(apiKeys, eq(apiKeys.principalId, usage.principalId))
      .where(and(inWorkspace, ne(usage.principalId, usage.actingUserId)))
      .groupBy(usage.principalId, apiKeys.id),
  ]);
  return [
    ...people.map((r) => ({
      principalId: r.principalId,
      keyId: null,
      spentMicroUsd: BigInt(r.cost),
    })),
    ...keys.map((r) => ({
      principalId: r.principalId,
      keyId: r.keyId,
      spentMicroUsd: BigInt(r.cost),
    })),
  ];
}
