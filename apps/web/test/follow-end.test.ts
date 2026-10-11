import { describe, expect, it } from 'vitest';
import { isAtEnd, NEAR_END_PX } from '../src/components/chat/follow-end.ts';

/* When the thread counts as at its end, and so follows a reply as it grows (CH-1, ADR 0105). */

const box = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({
  scrollHeight,
  scrollTop,
  clientHeight,
});

describe('following the end of the thread (CH-1)', () => {
  it('CH-1: at the end, or within 48px of it, counts as at the end', () => {
    expect(isAtEnd(box(2000, 1400, 600))).toBe(true);
    expect(isAtEnd(box(2000, 1400 - NEAR_END_PX, 600))).toBe(true);
    // A thread shorter than its box is always at its end.
    expect(isAtEnd(box(300, 0, 600))).toBe(true);
  });

  it('CH-1: further up is away from the end', () => {
    expect(isAtEnd(box(2000, 1400 - NEAR_END_PX - 1, 600))).toBe(false);
    expect(isAtEnd(box(2000, 0, 600))).toBe(false);
  });
});
