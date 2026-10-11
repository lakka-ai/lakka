import { describe, expect, it } from 'vitest';
import { cosine, l2Normalize, meanPool, truncate } from '../src/classifier/pooling.ts';

describe('classifier pooling', () => {
  it('averages only the tokens the attention mask keeps', () => {
    // 3 tokens x 2 dimensions; the third token is padding.
    const hidden = Float32Array.from([1, 2, 3, 4, 100, 100]);
    expect(Array.from(meanPool(hidden, [1, 1, 0], 2))).toEqual([2, 3]);
  });

  it('rejects hidden states that do not match the mask', () => {
    expect(() => meanPool(new Float32Array(5), [1, 1, 1], 2)).toThrow(RangeError);
  });

  it('normalizes to unit length and leaves a zero vector alone', () => {
    const v = l2Normalize(Float32Array.from([3, 4]));
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    expect(Array.from(l2Normalize(new Float32Array(3)))).toEqual([0, 0, 0]);
  });

  it('computes cosine similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('truncates long inputs but keeps the closing token', () => {
    const input = {
      ids: [101, 5, 6, 7, 8, 102],
      attentionMask: [1, 1, 1, 1, 1, 1],
      tokenTypeIds: [0, 0, 0, 0, 0, 0],
    };
    expect(truncate(input, 4)).toEqual({
      ids: [101, 5, 6, 102],
      attentionMask: [1, 1, 1, 1],
      tokenTypeIds: [0, 0, 0, 0],
    });
    expect(truncate(input, 10)).toBe(input);
  });
});
