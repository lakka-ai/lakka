import { describe, expect, it } from 'vitest';
import { readCap, smallestHeadroom, usedUpCap } from '../src/lib/budget-meter.ts';
import type { MeterCap } from '../src/lib/budget-meter.ts';

const usd = (dollars: number) => String(BigInt(Math.round(dollars * 100)) * 10_000n);
const cap = (name: string, limit: number, used: number, extra: Partial<MeterCap> = {}) => ({
  name,
  limitMicro: usd(limit),
  usedMicro: usd(used),
  period: 'Every month.',
  resets: 'Resets Oct 1',
  ...extra,
});

describe('budget meter (CH-4)', () => {
  it('CH-4: shows the cap with the least left, not the one used most', () => {
    // Fixtures: Maja has $17.60 left of $200; the workspace has $0.40 left of $1,000.
    const reading = smallestHeadroom([
      cap('Your cap', 200, 182.4),
      cap('Workspace cap', 1000, 999.6),
    ]);
    expect(reading?.cap.name).toBe('Workspace cap');
    expect(reading?.leftMicro).toBe(400_000n);
  });

  it('CH-4: a used-up cap is the one that blocks Send, and a low one does not', () => {
    expect(
      usedUpCap([cap('Your cap', 200, 182.4), cap('Workspace cap', 1000, 1000)])?.cap.name,
    ).toBe('Workspace cap');
    expect(usedUpCap([cap('Workspace cap', 1000, 999.6)])).toBeNull();
    expect(usedUpCap([])).toBeNull();
  });

  it('CH-4: is hidden when no cap applies', () => {
    expect(smallestHeadroom([])).toBeNull();
  });

  it('CH-4: low starts at 20 percent left', () => {
    expect(readCap(cap('Your cap', 50, 31.2)).state).toBe('healthy');
    expect(readCap(cap('Your cap', 100, 80)).state).toBe('low');
    expect(readCap(cap('Your cap', 100, 79)).state).toBe('healthy');
  });

  it('CH-4: low starts where the api says, when an alert moved it earlier', () => {
    expect(readCap(cap('Your cap', 100, 55, { lowAtPercentLeft: 50 })).state).toBe('low');
    expect(readCap(cap('Your cap', 100, 45, { lowAtPercentLeft: 50 })).state).toBe('healthy');
  });

  it('CH-4: used up at nothing left, including a cap overspent by a settled request', () => {
    const reading = readCap(cap('Key cap', 25, 25.3));
    expect(reading.state).toBe('exhausted');
    expect(reading.leftMicro).toBe(0n);
    expect(reading.percentLeft).toBe(0);
  });
});
