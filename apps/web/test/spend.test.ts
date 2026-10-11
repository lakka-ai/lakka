import { describe, expect, it } from 'vitest';
import { scaleStep } from '../src/components/spend/chart.tsx';
import {
  formatDays,
  formatSeconds,
  joinAndPercents,
  joinList,
  lowAtPercentLeft,
  ALERT_SUGGESTIONS,
  parseAlertPercent,
  rangeDays,
  shareOfLargest,
  sharePercent,
  topRows,
} from '../src/lib/spend.ts';

const usd = (dollars: number) => String(BigInt(Math.round(dollars * 100)) * 10_000n);

describe('the Spend screens (BG-11)', () => {
  it('BG-11: the date pills cover whole UTC days', () => {
    const now = new Date('2026-09-28T21:30:00Z');
    expect(rangeDays('this-month', now)).toEqual({ from: '2026-09-01', to: '2026-09-28' });
    expect(rangeDays('last-month', now)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(rangeDays('last-7-days', now)).toEqual({ from: '2026-09-22', to: '2026-09-28' });
    expect(rangeDays('custom', now, { from: '2026-09-02', to: '2026-09-05' })).toEqual({
      from: '2026-09-02',
      to: '2026-09-05',
    });
    expect(rangeDays('custom', now)).toBeNull();
    // Last month from January is December of the year before.
    expect(rangeDays('last-month', new Date('2027-01-03T00:00:00Z'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });

  it('BG-11: the chosen dates are also written as text', () => {
    expect(formatDays('2026-09-01', '2026-09-28')).toBe('Sep 1 to Sep 28, 2026');
    expect(formatDays('2026-12-20', '2027-01-05')).toBe('Dec 20, 2026 to Jan 5, 2027');
    expect(formatDays('2026-09-30', '2026-09-30')).toBe('Sep 30, 2026');
  });

  it('BG-11: shares have one decimal and never divide by nothing', () => {
    // Fixtures: Maja spent $182.40 of $999.60.
    expect(sharePercent(usd(182.4), usd(999.6))).toBe('18.2%');
    expect(sharePercent(usd(0), usd(999.6))).toBe('0.0%');
    expect(sharePercent(usd(1), '0')).toBe('0.0%');
    expect(shareOfLargest(usd(50), BigInt(usd(100)))).toBe(0.5);
    expect(shareOfLargest(usd(50), 0n)).toBe(0);
  });

  it('BG-11: By person shows six people, then what the others add up to', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      key: String(i),
      costMicroUsd: usd(10 - i),
      requests: 1,
    }));
    const { shown, others } = topRows(rows, 6);
    expect(shown.map((r) => r.key)).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(others).toEqual({ count: 3, costMicroUsd: usd(4 + 3 + 2), requests: 3 });
    // One more than the limit is shown, not folded into "1 other".
    expect(topRows(rows.slice(0, 7), 6)).toEqual({ shown: rows.slice(0, 7), others: null });
  });

  it('CH-4: a cap turns low at 20 percent left, or at an earlier first alert', () => {
    expect(lowAtPercentLeft([])).toBe(20);
    expect(lowAtPercentLeft([80, 100])).toBe(20);
    expect(lowAtPercentLeft([50, 90])).toBe(50);
  });

  it('BG-10: alerts suggest every 10 percent up to 100', () => {
    expect(ALERT_SUGGESTIONS).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it('BG-10: a typed alert is a whole percentage from 1 to 100, as the api takes', () => {
    expect(parseAlertPercent('75')).toBe(75);
    expect(parseAlertPercent(' 90 % ')).toBe(90);
    for (const bad of ['0', '101', '150', '12.5', 'fifty', ''])
      expect(parseAlertPercent(bad)).toBeUndefined();
  });

  it('lists read as the boards write them', () => {
    expect(joinList(['Chat'])).toBe('Chat');
    expect(joinList(['Chat', 'API', 'MCP'])).toBe('Chat, API and MCP');
    expect(joinList(['Maja Lind', 'Erik Holm'], 'or')).toBe('Maja Lind or Erik Holm');
    expect(joinAndPercents([80, 100])).toBe('80% and 100%');
    expect(formatSeconds(14_800)).toBe('14.8 s');
  });

  it('the day chart has three steps of 1, 2 or 5 of a power of ten, as drawn', () => {
    // The board: a $53.18 day on a scale to $60 in $20 steps.
    expect(scaleStep(BigInt(usd(53.18)))).toBe(BigInt(usd(20)));
    expect(scaleStep(BigInt(usd(12)))).toBe(BigInt(usd(5)));
    expect(scaleStep(BigInt(usd(0.01)))).toBe(BigInt(usd(0.01)));
    expect(scaleStep(0n)).toBe(BigInt(usd(1)));
  });
});
