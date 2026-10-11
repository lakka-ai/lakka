import { createHash, randomBytes } from 'node:crypto';
import { API_KEY_PATTERN } from '@lakka/contracts';

/*
 * API key secrets (ID-5, ADR 0030): "lk_" and 32 random bytes in base64url. With 256 bits of
 * entropy a fast digest is safe to store and to look up by; there is nothing to brute-force.
 */

const PREFIX_LENGTH = 11; // "lk_" and 8 characters, shown in lists

export interface KeySecret {
  secret: string;
  prefix: string;
  hash: string;
}

export function generateKeySecret(): KeySecret {
  const secret = `lk_${randomBytes(32).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, PREFIX_LENGTH), hash: hashKeySecret(secret) };
}

export function hashKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function looksLikeKeySecret(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}
