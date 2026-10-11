import { z } from 'zod';

/*
 * Budgets (BG-1, BG-9, ADR 0049). A budget caps spend at one scope, and scopes nest: a key's cap
 * sits inside its owner's member cap, inside the workspace cap, inside the instance cap. Each has
 * a reset period. Money is integer micro-USD, sent as a decimal string because it can exceed what
 * a JSON number holds exactly.
 */

export const BUDGET_SCOPES = ['instance', 'workspace', 'member', 'key'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_PERIODS = ['daily', 'monthly', 'none'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/**
 * Up to $1 billion, far beyond any real cap. Valkey's Lua compares amounts as doubles, which are
 * exact only up to 2^53 (about 9 * 10^15), so caps and holds must stay well below that (ADR 0050).
 */
export const MAX_BUDGET_MICRO_USD = 10n ** 15n - 1n;

export const DEFAULT_ALERT_PERCENTS = [80, 100] as const;

export const budgetBody = z
  .object({
    limitMicroUsd: z
      .string()
      .regex(/^(0|[1-9]\d{0,14})$/, 'a whole number of micro-USD, without leading zeros'),
    period: z.enum(BUDGET_PERIODS),
    /** Percentages of the limit that send an alert, once per period each (BG-10). */
    alertPercents: z
      .array(z.int().min(1).max(100))
      .max(5)
      .refine((p) => new Set(p).size === p.length, 'each percentage once')
      .default([...DEFAULT_ALERT_PERCENTS]),
  })
  .strict();
export type BudgetBody = z.infer<typeof budgetBody>;

export const memberBudgetParams = z.object({ workspaceId: z.uuid(), principalId: z.uuid() });

export interface BudgetView {
  id: string;
  scope: BudgetScope;
  workspaceId: string | null;
  /** The member's user principal, or the key's own principal. */
  principalId: string | null;
  /** The member's or the key's display name. */
  name: string | null;
  /** For a key: the api_keys row, as the key endpoints name it. */
  keyId: string | null;
  limitMicroUsd: string;
  period: BudgetPeriod;
  alertPercents: number[];
  /** The current period, in UTC. For 'none', the period never ends. */
  periodStart: string;
  periodEnd: string | null;
  /** Spend recorded against the current period. */
  spentMicroUsd: string;
  updatedAt: string;
}

/** Every budget that applies inside a workspace, from the instance cap down. */
export interface WorkspaceBudgetsView {
  instance: BudgetView | null;
  workspace: BudgetView | null;
  members: BudgetView[];
  keys: BudgetView[];
  /**
   * What each person and key spent this calendar month (UTC), capped or not (ADR 0093), for the
   * Used column of those with no cap. A person's includes their keys', as their cap counts it.
   * Only the rows the caller may see: a member gets their own and their keys'.
   */
  monthSpend: { principalId: string; keyId: string | null; spentMicroUsd: string }[];
}

/**
 * Whether budgets can be checked now (BG-4): when they cannot, every request is refused until
 * they can. Spend already recorded is still there to read.
 */
export interface BudgetStatusView {
  available: boolean;
}

/**
 * One cap the caller's requests count against, as the budget meter shows it (CH-4, ADR 0092):
 * its size, what is left, and when it resets. Never anyone's spend by person.
 */
export interface AppliedCapView {
  scope: BudgetScope;
  limitMicroUsd: string;
  remainingMicroUsd: string;
  period: BudgetPeriod;
  /** When the period ends and the cap resets, or null if it never does. */
  periodEnd: string | null;
  /**
   * Where the meter turns low, in percent left: 20, or more when an admin set the first alert
   * earlier. Given instead of the alert settings themselves.
   */
  lowAtPercentLeft: number;
}

/**
 * What the caller can still spend in a workspace (CH-4, ADR 0061, ADR 0092): the smallest headroom
 * among the caps their requests count against, and which cap that is, and each of those caps.
 */
export interface RemainingBudgetView {
  remainingMicroUsd: string;
  scope: BudgetScope;
  /** When that cap's period ends and it resets, or null if it never does. */
  periodEnd: string | null;
  /** Every cap that applies, narrowest first: the member's own, the workspace's, the instance's. */
  caps: AppliedCapView[];
}

const NONE_START = new Date(0);

/**
 * The start of the period containing `now`, in UTC (F1): midnight for daily, the first of the
 * month for monthly, and the epoch for a budget that never resets.
 */
export function periodStart(period: BudgetPeriod, now: Date): Date {
  switch (period) {
    case 'daily':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    case 'monthly':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    case 'none':
      return NONE_START;
  }
}

/** When the period that began at `start` ends, or null if it never does. */
export function periodEnd(period: BudgetPeriod, start: Date): Date | null {
  switch (period) {
    case 'daily':
      return new Date(start.getTime() + 24 * 60 * 60 * 1000);
    case 'monthly':
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    case 'none':
      return null;
  }
}

/*
 * Where budget alerts go (BG-10, NF-P2, ADR 0054): nothing is sent until an admin creates a
 * webhook. Every request is signed with a secret shown once, when the webhook is created.
 */
export const alertWebhookBody = z
  .object({ url: z.url({ protocol: /^https?$/ }).max(2000) })
  .strict();
export type AlertWebhookBody = z.infer<typeof alertWebhookBody>;

export interface AlertWebhookView {
  url: string;
  createdAt: string;
}

/** The result of a test alert, sent at once rather than queued. */
export interface WebhookTestResult {
  delivered: boolean;
  /** Why it was not, as our own code (http_500, private_address, timeout, ...). */
  error: string | null;
}

/** What a webhook receives for Send a test alert: no budget, only who it is for. */
export interface BudgetTestPayload {
  type: 'budget.test';
  id: string;
  occurredAt: string;
  workspace: { id: string; name: string } | null;
}

export interface CreatedAlertWebhook {
  webhook: AlertWebhookView;
  /** Signs every delivery (HMAC-SHA256). Shown once; only an encrypted copy is kept. */
  secret: string;
}

/** What a webhook receives when a budget crosses a threshold. */
export interface BudgetAlertPayload {
  type: 'budget.threshold';
  id: string;
  occurredAt: string;
  budget: {
    id: string;
    scope: BudgetScope;
    period: BudgetPeriod;
    periodStart: string;
    workspace: { id: string; name: string } | null;
    /** The member or key the cap belongs to. */
    principal: { id: string; name: string } | null;
  };
  percent: number;
  spentMicroUsd: string;
  limitMicroUsd: string;
}

/** One budget alert and what became of it, for the delivery history (BG-10, ADR 0079). */
export interface BudgetAlertView {
  id: string;
  scope: BudgetScope;
  /** The person or key a member or key cap belongs to; null for workspace and instance caps. */
  subject: string | null;
  percent: number;
  periodStart: string;
  state: 'pending' | 'enqueued' | 'delivered' | 'failed' | 'no_destination';
  attempts: number;
  /** Why the last delivery failed, as our own code (http_500, private_address, ...). */
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}
