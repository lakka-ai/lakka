import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BudgetPeriod, BudgetScope } from '@lakka/contracts';
import type { Db } from '../client.ts';
import { alertWebhooks, budgetAlerts, budgets } from '../schema/budgets.ts';
import { principals, workspaces } from '../schema/identity.ts';

/*
 * Budget alerts and where they go (BG-10, ADR 0054). Webhooks are scoped: the instance webhook
 * has no workspace, and a workspace's is read and written through its id.
 */

export interface AlertWebhookRow {
  id: string;
  workspaceId: string | null;
  url: string;
  createdAt: Date;
}

const webhookWhere = (workspaceId: string | null) =>
  workspaceId === null
    ? isNull(alertWebhooks.workspaceId)
    : eq(alertWebhooks.workspaceId, workspaceId);

export async function findAlertWebhook(
  db: Db,
  workspaceId: string | null,
): Promise<AlertWebhookRow | undefined> {
  const [row] = await db
    .select({
      id: alertWebhooks.id,
      workspaceId: alertWebhooks.workspaceId,
      url: alertWebhooks.url,
      createdAt: alertWebhooks.createdAt,
    })
    .from(alertWebhooks)
    .where(webhookWhere(workspaceId));
  return row;
}

/** Creates or replaces the webhook for the instance (null) or a workspace. */
export async function setAlertWebhook(
  db: Db,
  workspaceId: string | null,
  value: { url: string; secret: string; createdByPrincipalId: string },
): Promise<AlertWebhookRow> {
  await db.transaction(async (tx) => {
    await tx.delete(alertWebhooks).where(webhookWhere(workspaceId));
    await tx.insert(alertWebhooks).values({ workspaceId, ...value });
  });
  const row = await findAlertWebhook(db, workspaceId);
  if (row === undefined) throw new Error('webhook write returned nothing');
  return row;
}

/** Points the webhook somewhere else and keeps its secret. Undefined when there is none. */
export async function updateAlertWebhookUrl(
  db: Db,
  workspaceId: string | null,
  url: string,
): Promise<AlertWebhookRow | undefined> {
  const [row] = await db
    .update(alertWebhooks)
    .set({ url })
    .where(webhookWhere(workspaceId))
    .returning({
      id: alertWebhooks.id,
      workspaceId: alertWebhooks.workspaceId,
      url: alertWebhooks.url,
      createdAt: alertWebhooks.createdAt,
    });
  return row;
}

/** Replaces the webhook's secret and keeps its address. Undefined when there is none. */
export async function rotateAlertWebhookSecret(
  db: Db,
  workspaceId: string | null,
  secret: string,
): Promise<AlertWebhookRow | undefined> {
  const [row] = await db
    .update(alertWebhooks)
    .set({ secret })
    .where(webhookWhere(workspaceId))
    .returning({
      id: alertWebhooks.id,
      workspaceId: alertWebhooks.workspaceId,
      url: alertWebhooks.url,
      createdAt: alertWebhooks.createdAt,
    });
  return row;
}

export async function deleteAlertWebhook(db: Db, workspaceId: string | null): Promise<boolean> {
  const deleted = await db
    .delete(alertWebhooks)
    .where(webhookWhere(workspaceId))
    .returning({ id: alertWebhooks.id });
  return deleted.length > 0;
}

/** Alerts recorded but not yet handed to the job queue, oldest first. */
export async function listPendingAlerts(db: Db, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: budgetAlerts.id })
    .from(budgetAlerts)
    .where(eq(budgetAlerts.state, 'pending'))
    .orderBy(asc(budgetAlerts.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function markAlertsEnqueued(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(budgetAlerts)
    .set({ state: 'enqueued' })
    .where(and(inArray(budgetAlerts.id, [...ids]), eq(budgetAlerts.state, 'pending')));
}

export interface AlertForDelivery {
  id: string;
  budgetId: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  periodStart: Date;
  percent: number;
  spentMicroUsd: bigint;
  limitMicroUsd: bigint;
  state: string;
  createdAt: Date;
  workspaceId: string | null;
  workspaceName: string | null;
  principalId: string | null;
  principalName: string | null;
  /** Where it goes: the workspace's webhook, else the instance's; null if neither exists. */
  webhook: { url: string; secret: string; scope: 'instance' | 'workspace' } | null;
}

export async function findAlertForDelivery(
  db: Db,
  id: string,
): Promise<AlertForDelivery | undefined> {
  const [row] = await db
    .select({
      id: budgetAlerts.id,
      budgetId: budgetAlerts.budgetId,
      scope: budgets.scope,
      period: budgets.period,
      periodStart: budgetAlerts.periodStart,
      percent: budgetAlerts.percent,
      spentMicroUsd: budgetAlerts.spentMicroUsd,
      limitMicroUsd: budgetAlerts.limitMicroUsd,
      state: budgetAlerts.state,
      createdAt: budgetAlerts.createdAt,
      workspaceId: budgets.workspaceId,
      workspaceName: workspaces.name,
      principalId: budgets.principalId,
      principalName: principals.displayName,
    })
    .from(budgetAlerts)
    .innerJoin(budgets, eq(budgets.id, budgetAlerts.budgetId))
    .leftJoin(workspaces, eq(workspaces.id, budgets.workspaceId))
    .leftJoin(principals, eq(principals.id, budgets.principalId))
    .where(eq(budgetAlerts.id, id));
  if (row === undefined) return undefined;
  const own =
    row.workspaceId === null ? undefined : await findWebhookWithSecret(db, row.workspaceId);
  const instance = own === undefined ? await findWebhookWithSecret(db, null) : undefined;
  const webhook =
    own !== undefined
      ? { ...own, scope: 'workspace' as const }
      : instance !== undefined
        ? { ...instance, scope: 'instance' as const }
        : null;
  return { ...row, webhook };
}

export async function findWebhookWithSecret(
  db: Db,
  workspaceId: string | null,
): Promise<{ url: string; secret: string } | undefined> {
  const [row] = await db
    .select({ url: alertWebhooks.url, secret: alertWebhooks.secret })
    .from(alertWebhooks)
    .where(webhookWhere(workspaceId));
  return row;
}

export async function recordAlertOutcome(
  db: Db,
  id: string,
  outcome:
    | { state: 'delivered' }
    | { state: 'no_destination' }
    | { state: 'failed'; error: string }
    | { state: 'retrying'; error: string },
): Promise<void> {
  await db
    .update(budgetAlerts)
    .set({
      attempts: sql`${budgetAlerts.attempts} + ${outcome.state === 'no_destination' ? 0 : 1}`,
      ...(outcome.state === 'delivered'
        ? { state: 'delivered', deliveredAt: sql`now()`, lastError: null }
        : outcome.state === 'no_destination'
          ? { state: 'no_destination' }
          : outcome.state === 'failed'
            ? { state: 'failed', lastError: outcome.error }
            : { lastError: outcome.error }),
    })
    .where(eq(budgetAlerts.id, id));
}

export interface AlertHistoryRow {
  id: string;
  scope: BudgetScope;
  subject: string | null;
  percent: number;
  periodStart: Date;
  state: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

/**
 * The newest alerts for the instance's cap (null) or a workspace's caps, with who a member or key
 * cap belongs to: the delivery history an admin checks when an alert did not arrive (BG-10).
 */
export async function listBudgetAlerts(
  db: Db,
  workspaceId: string | null,
  limit: number,
): Promise<AlertHistoryRow[]> {
  return db
    .select({
      id: budgetAlerts.id,
      scope: budgets.scope,
      subject: principals.displayName,
      percent: budgetAlerts.percent,
      periodStart: budgetAlerts.periodStart,
      state: budgetAlerts.state,
      attempts: budgetAlerts.attempts,
      lastError: budgetAlerts.lastError,
      createdAt: budgetAlerts.createdAt,
      deliveredAt: budgetAlerts.deliveredAt,
    })
    .from(budgetAlerts)
    .innerJoin(budgets, eq(budgets.id, budgetAlerts.budgetId))
    .leftJoin(principals, eq(principals.id, budgets.principalId))
    .where(
      workspaceId === null ? isNull(budgets.workspaceId) : eq(budgets.workspaceId, workspaceId),
    )
    .orderBy(desc(budgetAlerts.createdAt))
    .limit(limit);
}
