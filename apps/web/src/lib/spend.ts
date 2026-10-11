import type { BudgetPeriod, BudgetView } from '@lakka/contracts';
import type { MeterCap } from './budget-meter.ts';

/*
 * What the Spend screens work out from the api's numbers (BG-11; Spend-Admin, Spend-Member and
 * Spend-Budgets boards): the date ranges, shares of a total, the top rows of a breakdown, and
 * where a cap's meter turns low. Amounts are integer micro-USD as decimal strings, as the api
 * sends them. Dates are whole UTC days (YYYY-MM-DD), as the report takes them.
 */

export const RANGES = ['this-month', 'last-month', 'last-7-days', 'custom'] as const;
export type RangeKind = (typeof RANGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The days a range covers, both ends included, or null for a custom range with none chosen. */
export function rangeDays(
  kind: RangeKind,
  now: Date,
  custom?: { from?: string | undefined; to?: string | undefined },
): { from: string; to: string } | null {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (kind) {
    case 'this-month':
      return {
        from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
        to: iso(today),
      };
    case 'last-month':
      return {
        from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))),
        to: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))),
      };
    case 'last-7-days':
      return { from: iso(new Date(today.getTime() - 6 * DAY_MS)), to: iso(today) };
    case 'custom':
      return custom?.from !== undefined && custom.to !== undefined
        ? { from: custom.from, to: custom.to }
        : null;
  }
}

const dayMonth = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayMonthYear = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Sep 1 to Sep 28, 2026", or with both years when they differ. */
export function formatDays(from: string, to: string): string {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  if (from === to) return dayMonthYear.format(a);
  const start =
    a.getUTCFullYear() === b.getUTCFullYear() ? dayMonth.format(a) : dayMonthYear.format(a);
  return `${start} to ${dayMonthYear.format(b)}`;
}

/** A part of a total as a percentage with one decimal: "18.2%". Never NaN. */
export function sharePercent(part: string, total: string): string {
  const whole = BigInt(total);
  if (whole <= 0n) return '0.0%';
  const tenths = (BigInt(part) * 1000n + whole / 2n) / whole;
  return `${tenths / 10n}.${tenths % 10n}%`;
}

/** A part of the largest, 0 to 1, for a decorative bar. */
export function shareOfLargest(part: string, largest: bigint): number {
  if (largest <= 0n) return 0;
  return Number((BigInt(part) * 10_000n) / largest) / 10_000;
}

export interface Summable {
  costMicroUsd: string;
  requests: number;
}

/**
 * The first rows of a breakdown and what the rest add up to, as "6 others" on the board. With
 * one row over the limit, it is shown instead: "1 other" hides nothing worth hiding.
 */
export function topRows<Row extends Summable>(
  rows: readonly Row[],
  limit: number,
): { shown: Row[]; others: { count: number; costMicroUsd: string; requests: number } | null } {
  if (rows.length <= limit + 1) return { shown: [...rows], others: null };
  const rest = rows.slice(limit);
  return {
    shown: rows.slice(0, limit),
    others: {
      count: rest.length,
      costMicroUsd: String(rest.reduce((sum, r) => sum + BigInt(r.costMicroUsd), 0n)),
      requests: rest.reduce((sum, r) => sum + r.requests, 0),
    },
  };
}

/** "a", "a and b", "a, b and c", as the boards join lists: no comma before the last word. */
export function joinList(items: readonly string[], word: 'and' | 'or' = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1) ?? ''}`;
}

/** Alert percentages as a cap card lists them: "80% and 100%". */
export const joinAndPercents = (percents: readonly number[]) =>
  joinList(percents.map((n) => `${n}%`));

/** A time in seconds with one decimal, as the speed table writes it: 4200 -> "4.2 s". */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

const count = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

/** A count with thousands separators: 6412 -> "6,412". */
export function formatCount(n: number): string {
  return count.format(n);
}

/** Where a cap's meter turns low (Pattern 2): 20 percent left, or earlier with an earlier alert. */
export function lowAtPercentLeft(alertPercents: readonly number[]): number {
  return Math.max(20, alertPercents.length === 0 ? 0 : 100 - Math.min(...alertPercents));
}

/** A cap as the budget meter and the caps tables read it. */
export function capReading(
  budget: BudgetView,
  names: { name: string; period: string; resets?: string },
): MeterCap {
  return {
    name: names.name,
    limitMicro: budget.limitMicroUsd,
    usedMicro: budget.spentMicroUsd,
    period: names.period,
    ...(names.resets === undefined ? {} : { resets: names.resets }),
    lowAtPercentLeft: lowAtPercentLeft(budget.alertPercents),
  };
}

/** The periods a cap can have, in the order the dialog lists them. */
export const PERIODS: readonly BudgetPeriod[] = ['daily', 'monthly', 'none'];

/** At most five alert percentages, each a whole number from 1 to 100 (BG-10). */
export const MAX_ALERTS = 5;

/** A typed alert percentage, such as "75" or "75 %", if it is one the api takes. */
export function parseAlertPercent(text: string): number | undefined {
  const trimmed = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= 1 && n <= 100 ? n : undefined;
}

/**
 * The alert percentages a cap suggests: every 10 from 10 to 100. Others are typed. The list stops
 * at 100: spend never passes a cap, so a higher alert could never be sent.
 */
export const ALERT_SUGGESTIONS: readonly number[] = Array.from(
  { length: 10 },
  (_, i) => (i + 1) * 10,
);
