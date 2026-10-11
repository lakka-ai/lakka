/*
 * What the budget meter shows (CH-4; docs/design/docs/patterns.md, Pattern 2): of the caps
 * that apply to a request, the one with the least left, and whether that is healthy, low or
 * used up. The meter shows what is left, not what is used.
 *
 * Low starts at 20 percent left, or earlier when an admin set the first alert threshold lower
 * than 80 percent used: an alert at 50 percent used makes 50 percent left low. The api works
 * that out and sends it, rather than the alert settings (ADR 0092).
 *
 * Amounts are integer micro-USD as decimal strings, as the api sends them.
 */

export interface MeterCap {
  /** The cap's name as a label: "Your cap", "Workspace cap". */
  name: string;
  /** The cap's name inside a sentence: "your cap", "the workspace cap". */
  inSentence?: string;
  limitMicro: string;
  usedMicro: string;
  /** How often it resets, as a sentence: "Every month." */
  period: string;
  /** When it resets: "Resets Oct 1". Absent for a cap that never resets. */
  resets?: string;
  /** Where the meter turns low, in percent left, as the api works it out (ADR 0092). */
  lowAtPercentLeft?: number;
}

export type MeterState = 'healthy' | 'low' | 'exhausted';

export interface MeterReading {
  cap: MeterCap;
  leftMicro: bigint;
  limitMicro: bigint;
  /** What is left as a share of the cap, 0 to 100, rounded down. */
  percentLeft: number;
  state: MeterState;
}

const DEFAULT_LOW_PERCENT_LEFT = 20;

export function readCap(cap: MeterCap): MeterReading {
  const limit = BigInt(cap.limitMicro);
  const used = BigInt(cap.usedMicro);
  const left = limit > used ? limit - used : 0n;
  const percentLeft = limit > 0n ? Number((left * 100n) / limit) : 0;
  const lowAt = cap.lowAtPercentLeft ?? DEFAULT_LOW_PERCENT_LEFT;
  const state: MeterState = left === 0n ? 'exhausted' : percentLeft <= lowAt ? 'low' : 'healthy';
  return { cap, leftMicro: left, limitMicro: limit, percentLeft, state };
}

/** The cap with the least left, in money, or null when no cap applies. */
export function smallestHeadroom(caps: readonly MeterCap[]): MeterReading | null {
  let smallest: MeterReading | null = null;
  for (const cap of caps) {
    const reading = readCap(cap);
    if (smallest === null || reading.leftMicro < smallest.leftMicro) smallest = reading;
  }
  return smallest;
}

/**
 * The cap that is used up, if one is: nothing more can be sent until it resets or is raised, so
 * Send says so (accessibility.md, Chat; Chat-Phone-Exhausted).
 */
export function usedUpCap(caps: readonly MeterCap[]): MeterReading | null {
  const reading = smallestHeadroom(caps);
  return reading?.state === 'exhausted' ? reading : null;
}
