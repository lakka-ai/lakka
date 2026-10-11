import { describe, expect, it } from 'vitest';
import { uuidv7, uuidv7Timestamp } from '../src/uuid.ts';

describe('uuidv7', () => {
  it('has version 7 and the RFC 9562 variant', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes the creation time in the first 48 bits', () => {
    expect(uuidv7Timestamp(uuidv7(1_767_225_600_123))).toBe(1_767_225_600_123);
  });

  it('sorts by creation time across milliseconds', () => {
    const ids = [3, 1, 2].map((offset) => uuidv7(1_767_225_600_000 + offset));
    expect(ids.toSorted()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(1_767_225_600_000)));
    expect(ids.size).toBe(10_000);
  });

  it('rejects timestamps outside 48 bits', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
  });
});
