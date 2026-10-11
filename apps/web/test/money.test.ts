import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatDollarsPerMtok,
  formatMicroUsd,
  parseDollars,
  parseDollarsPerMtok,
} from '../src/lib/money.ts';

describe('prices in the UI (ADR 0037)', () => {
  it('PR-7: converts dollars per million tokens to micro-USD exactly', () => {
    expect(parseDollarsPerMtok('3')).toBe(3_000_000);
    expect(parseDollarsPerMtok('0.075')).toBe(75_000);
    expect(parseDollarsPerMtok(' $15.50 ')).toBe(15_500_000);
    expect(parseDollarsPerMtok('0')).toBe(0);
    expect(parseDollarsPerMtok('0.000001')).toBe(1);
  });

  it('refuses anything that is not a plain amount', () => {
    for (const bad of ['', '-1', '1e3', '0.0000001', 'abc', '1,50', '1.']) {
      expect(parseDollarsPerMtok(bad)).toBeUndefined();
    }
  });

  it('formats without trailing zeros or float noise', () => {
    expect(formatDollarsPerMtok(3_000_000)).toBe('$3');
    expect(formatDollarsPerMtok(75_000)).toBe('$0.075');
    expect(formatDollarsPerMtok(22_500_000)).toBe('$22.5');
    expect(formatDollarsPerMtok(0)).toBe('$0');
  });

  it('RT-10: shows signed micro-USD amounts in dollars and cents, never a non-zero amount as zero', () => {
    expect(formatMicroUsd('49750000')).toBe('$49.75');
    expect(formatMicroUsd('-2250000')).toBe('-$2.25');
    expect(formatMicroUsd('0')).toBe('$0.00');
    expect(formatMicroUsd('5000')).toBe('$0.01');
    expect(formatMicroUsd('4999')).toBe('$0.01');
    expect(formatMicroUsd('-1')).toBe('-$0.01');
    expect(formatMicroUsd('1234565000')).toBe('$1,234.57');
    // Beyond what a JSON number holds exactly.
    expect(formatMicroUsd('9007199254740993000000')).toBe('$9,007,199,254,740,993.00');
  });

  it('BG-1: turns a typed dollar cap into exact micro-USD, and refuses anything else', () => {
    expect(parseDollars('25')).toBe('25000000');
    expect(parseDollars(' $0.50 ')).toBe('500000');
    expect(parseDollars('1,250.000001')).toBe('1250000001');
    expect(parseDollars('0')).toBe('0');
    expect(parseDollars('999999999.999999')).toBe('999999999999999');
    for (const bad of ['', '-5', '1e3', '1.0000001', '1000000000', 'ten', '1.']) {
      expect({ bad, parsed: parseDollars(bad) }).toEqual({ bad, parsed: undefined });
    }
  });

  it('CH-4: a request cost has four decimals, rounded up so it is never shown as less', () => {
    expect(formatCost('7300')).toBe('$0.0073');
    expect(formatCost('3101')).toBe('$0.0032');
    expect(formatCost('1')).toBe('$0.0001');
    expect(formatCost('0')).toBe('$0.0000');
    expect(formatCost('12345678900')).toBe('$12,345.6789');
  });
});
