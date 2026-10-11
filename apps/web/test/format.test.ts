import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDay, formatDuration } from '../src/lib/format.ts';

describe('formatDateTime', () => {
  it('shows UTC with the zone named, the same on the server and in any browser', () => {
    expect(formatDateTime('2026-10-02T18:52:35.031Z')).toBe('Oct 2, 2026, 18:52 UTC');
  });
});

describe('formatDuration', () => {
  it('OB-1: writes trace durations as the copy rules do, and says them in full', () => {
    expect(formatDuration(4)).toEqual({ text: '4 ms', spoken: '4 milliseconds' });
    expect(formatDuration(1)).toEqual({ text: '1 ms', spoken: '1 millisecond' });
    expect(formatDuration(2410)).toEqual({ text: '2.41 s', spoken: '2.41 seconds' });
    expect(formatDuration(23_900)).toEqual({ text: '23.9 s', spoken: '23.9 seconds' });
    expect(formatDuration(30_000)).toEqual({ text: '30.0 s', spoken: '30.0 seconds' });
  });
});

describe('formatDay', () => {
  it('writes a date as the copy rules do, in UTC', () => {
    expect(formatDay('2026-10-01T00:00:00.000Z')).toBe('Oct 1');
    expect(formatDay('2026-09-28T23:59:00.000Z')).toBe('Sep 28');
  });
});
