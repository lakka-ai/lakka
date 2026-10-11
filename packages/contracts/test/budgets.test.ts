import { describe, expect, it } from 'vitest';
import { budgetBody, periodEnd, periodStart } from '../src/budgets.ts';

const at = (iso: string) => new Date(iso);
const ok = (limitMicroUsd: string) =>
  budgetBody.safeParse({ limitMicroUsd, period: 'monthly' }).success;

describe('budget periods (BG-9, F1)', () => {
  it('BG-9: a daily period runs from UTC midnight to the next', () => {
    const start = periodStart('daily', at('2026-09-26T23:59:59.999Z'));
    expect(start.toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(periodEnd('daily', start)?.toISOString()).toBe('2026-09-27T00:00:00.000Z');
    // A local evening that is already tomorrow in UTC belongs to tomorrow.
    expect(periodStart('daily', at('2026-09-26T22:30:00-02:00')).toISOString()).toBe(
      '2026-09-27T00:00:00.000Z',
    );
  });

  it('BG-9: a monthly period is the UTC calendar month, across year ends and leap years', () => {
    expect(periodStart('monthly', at('2026-12-31T23:00:00Z')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    );
    expect(periodEnd('monthly', at('2026-12-01T00:00:00Z'))?.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(periodEnd('monthly', at('2028-02-01T00:00:00Z'))?.toISOString()).toBe(
      '2028-03-01T00:00:00.000Z',
    );
    expect(periodStart('monthly', at('2028-02-29T12:00:00Z')).toISOString()).toBe(
      '2028-02-01T00:00:00.000Z',
    );
  });

  it('BG-9: a budget that never resets has one period, from the epoch, with no end', () => {
    const start = periodStart('none', at('2031-05-05T05:05:05Z'));
    expect(start.getTime()).toBe(0);
    expect(periodEnd('none', start)).toBeNull();
  });

  it('BG-1: limits are whole micro-USD as a decimal string, within range', () => {
    expect(ok('0')).toBe(true);
    expect(ok('10000000')).toBe(true);
    expect(ok('999999999999999')).toBe(true);
    for (const bad of ['', '-1', '1.5', '01', '1000000000000000', '1e6', ' 5']) {
      expect({ bad, ok: ok(bad) }).toEqual({ bad, ok: false });
    }
    expect(budgetBody.safeParse({ limitMicroUsd: 5, period: 'monthly' }).success).toBe(false);
    expect(budgetBody.safeParse({ limitMicroUsd: '5', period: 'weekly' }).success).toBe(false);
  });
});
