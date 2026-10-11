import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  smallint,
  uniqueIndex,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { BUDGET_PERIODS, BUDGET_SCOPES } from '@lakka/contracts';
import { encryptedText } from '../crypto.ts';
import { uuidv7 } from '../uuid.ts';
import { principals, workspaces } from './identity.ts';

/*
 * Budgets (BG-1, BG-9, ADR 0049). One row per capped scope: the instance, a workspace, a member
 * of a workspace, or a key. Postgres is the truth for limits and spend; Valkey only counts live
 * reservations and is rebuilt from here (invariant 5).
 *
 * Spend is kept per budget and per period in budget_spend, so a new period starts from zero by
 * having no row yet, and a request reserved in one period is charged to that period even if it
 * finishes in the next.
 */

const microUsd = (name: string) => bigint(name, { mode: 'bigint' });

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    scope: text('scope', { enum: BUDGET_SCOPES }).notNull(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    /** The member's user principal, or the key's own principal. */
    principalId: uuid('principal_id').references(() => principals.id),
    limitMicroUsd: microUsd('limit_micro_usd').notNull(),
    period: text('period', { enum: BUDGET_PERIODS }).notNull(),
    /** Spend percentages of the limit that send an alert, once per period each (BG-10). */
    alertPercents: smallint('alert_percents')
      .array()
      .notNull()
      .default(sql`'{80,100}'::smallint[]`),
    /** Who set the current limit; a key's owner may change only caps they set themselves. */
    updatedByPrincipalId: uuid('updated_by_principal_id').notNull(),
    updatedByKind: text('updated_by_kind').generatedAlwaysAs(sql`'user'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one cap per scope target; the instance has workspace and principal both null.
    unique('budgets_target_key').on(t.scope, t.workspaceId, t.principalId).nullsNotDistinct(),
    index('budgets_workspace_id_idx').on(t.workspaceId),
    foreignKey({
      name: 'budgets_updated_by_is_user_fkey',
      columns: [t.updatedByPrincipalId, t.updatedByKind],
      foreignColumns: [principals.id, principals.kind],
    }),
    check('budgets_scope_check', sql`${t.scope} in ('instance', 'workspace', 'member', 'key')`),
    check('budgets_period_check', sql`${t.period} in ('daily', 'monthly', 'none')`),
    check('budgets_alert_percents_check', sql`cardinality(${t.alertPercents}) <= 5`),
    // Below 2^53, so Valkey's Lua compares amounts exactly (ADR 0050).
    check(
      'budgets_limit_check',
      sql`${t.limitMicroUsd} >= 0 and ${t.limitMicroUsd} <= 999999999999999`,
    ),
    check(
      'budgets_target_check',
      sql`(${t.scope} = 'instance' and ${t.workspaceId} is null and ${t.principalId} is null)
        or (${t.scope} = 'workspace' and ${t.workspaceId} is not null and ${t.principalId} is null)
        or (${t.scope} in ('member', 'key') and ${t.workspaceId} is not null and ${t.principalId} is not null)`,
    ),
  ],
);

export const budgetSpend = pgTable(
  'budget_spend',
  {
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    /** The start of the period, in UTC; the epoch for a budget that never resets. */
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    spentMicroUsd: microUsd('spent_micro_usd')
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'budget_spend_pkey', columns: [t.budgetId, t.periodStart] }),
    check('budget_spend_spent_check', sql`${t.spentMicroUsd} >= 0`),
  ],
);

export const RESERVATION_STATES = ['pending', 'active', 'denied', 'settled', 'abandoned'] as const;

/*
 * Reservations (BG-3, BG-5, BG-6, ADR 0050): the durable record of every hold, written before
 * Valkey is touched. 'pending' until Valkey granted it, then 'active'; 'denied' when a cap
 * refused it or a store failed; 'settled' with the actual cost; 'abandoned' when the sweep
 * settled it for a request that never came back. Only active reservations are
 * counted when a Valkey counter is rebuilt.
 */
export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey(),
    requestId: uuid('request_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    principalId: uuid('principal_id').notNull(),
    actingUserId: uuid('acting_user_id').notNull(),
    amountMicroUsd: microUsd('amount_micro_usd').notNull(),
    state: text('state', { enum: RESERVATION_STATES }).notNull(),
    actualMicroUsd: microUsd('actual_micro_usd'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    // One live reservation per request at a time: a denied attempt may be followed by a smaller
    // one (BG-7), and a tool loop reserves again for each round once the last is settled
    // (ADR 0071).
    uniqueIndex('reservations_request_live_key')
      .on(t.requestId)
      .where(sql`${t.state} in ('pending', 'active')`),
    index('reservations_state_expires_idx').on(t.state, t.expiresAt),
    check(
      'reservations_state_check',
      sql`${t.state} in ('pending', 'active', 'denied', 'settled', 'abandoned')`,
    ),
    check('reservations_amount_check', sql`${t.amountMicroUsd} >= 0`),
    check(
      'reservations_actual_check',
      sql`(${t.state} in ('settled', 'abandoned')) = (${t.actualMicroUsd} is not null)
        and (${t.actualMicroUsd} is null or ${t.actualMicroUsd} >= 0)
        and (${t.state} in ('settled', 'abandoned')) = (${t.settledAt} is not null)`,
    ),
  ],
);

/** The caps a reservation holds against, each in the period it was made in. */
export const reservationLines = pgTable(
  'reservation_lines',
  {
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'reservation_lines_pkey', columns: [t.reservationId, t.budgetId] }),
    index('reservation_lines_budget_period_idx').on(t.budgetId, t.periodStart),
  ],
);

/*
 * Where budget alerts go (BG-10, NF-P2, ADR 0054): one webhook for the instance, set by instance
 * admins, and at most one per workspace, set by its admins. Nothing is sent anywhere unless an
 * admin created one. The signing secret is encrypted at rest and shown once.
 */
export const alertWebhooks = pgTable(
  'alert_webhooks',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    /** Null for the instance webhook. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    url: text('url').notNull(),
    secret: encryptedText('secret', 'alert_webhooks.secret').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('alert_webhooks_workspace_key').on(t.workspaceId).nullsNotDistinct()],
);

export const ALERT_STATES = [
  'pending',
  'enqueued',
  'delivered',
  'failed',
  'no_destination',
] as const;

/**
 * A threshold a budget crossed in a period (BG-10): recorded once, in the transaction that
 * charged the spend, then delivered by the worker.
 */
export const budgetAlerts = pgTable(
  'budget_alerts',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    percent: smallint('percent').notNull(),
    spentMicroUsd: microUsd('spent_micro_usd').notNull(),
    limitMicroUsd: microUsd('limit_micro_usd').notNull(),
    state: text('state', { enum: ALERT_STATES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Why the last delivery failed: an HTTP status or an error code, never a response body. */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    unique('budget_alerts_once_key').on(t.budgetId, t.periodStart, t.percent),
    index('budget_alerts_state_idx').on(t.state, t.createdAt),
    check(
      'budget_alerts_state_check',
      sql`${t.state} in ('pending', 'enqueued', 'delivered', 'failed', 'no_destination')`,
    ),
  ],
);
