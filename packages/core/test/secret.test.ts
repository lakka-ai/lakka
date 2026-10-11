import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateKeySecret, hashKeySecret, looksLikeKeySecret } from '../src/keys/secret.ts';

describe('API key secrets', () => {
  it('ID-5: generates lk_ secrets with 256 bits of randomness and a short display prefix', () => {
    const { secret, prefix, hash } = generateKeySecret();
    expect(secret).toMatch(/^lk_[A-Za-z0-9_-]{43}$/);
    expect(secret.startsWith(prefix)).toBe(true);
    expect(prefix).toHaveLength(11);
    expect(hash).toBe(createHash('sha256').update(secret).digest('hex'));
  });

  it('never repeats', () => {
    const secrets = new Set(Array.from({ length: 1000 }, () => generateKeySecret().secret));
    expect(secrets.size).toBe(1000);
  });

  it('recognizes only well-formed secrets', () => {
    expect(looksLikeKeySecret(generateKeySecret().secret)).toBe(true);
    expect(looksLikeKeySecret('lk_short')).toBe(false);
    expect(looksLikeKeySecret(`sk_${'a'.repeat(43)}`)).toBe(false);
    expect(hashKeySecret('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
