import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { MAX_ALLOWED_ORIGINS } from './egress-policy.ts';
import type { EgressRule } from './egress-policy.ts';

/*
 * The token a stdio server shows the egress proxy (NF-S4, ADR 0118). The api makes one for each
 * operation it sends to the sandbox, with the rule that operation's server keeps to: the
 * instance's allowlist, the operator's private origins, and whether private addresses may be
 * reached. The proxy keeps no state of its own; the token is the whole of what it knows, so it
 * is signed, and it expires within 45 seconds, the longest an operation runs.
 *
 * The key is a file only the api and the proxy mount; the sandbox, where the token is used, has
 * no way to make one. A token that leaks from an operation works for what that operation could
 * reach anyway, until it expires.
 *
 * The rule is compressed: the token travels in an environment variable, which Linux caps at
 * 128 KB, and in a header. The MAC covers the compressed bytes and is checked before anything is
 * inflated.
 */

/** The longest a token lives: a tool's 30 s and the 15 s a runner may take to start. */
export const MAX_EGRESS_TOKEN_MS = 45_000;
/** The api and the proxy share a host's clock; this covers the time between making and use. */
const CLOCK_ALLOWANCE_MS = 2_000;
const VERSION = 'v1';
/** Inflating stops here: far more than a full allowlist, far less than a decompression bomb. */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** A key shorter than this is a mistake, such as an empty file. */
const MIN_KEY_LENGTH = 32;

const origin = z
  .string()
  .max(300)
  .regex(/^https?:\/\/[^/]+$/);

const claimsSchema = z.object({
  exp: z.int().positive(),
  sid: z.string().regex(/^[0-9a-f]{16}$/),
  rule: z.object({
    allowedOrigins: z.array(origin).max(MAX_ALLOWED_ORIGINS),
    privateOrigins: z.array(origin).max(MAX_ALLOWED_ORIGINS),
    allowPrivate: z.boolean(),
  }),
});

export interface EgressTokenClaims {
  /** When the token stops working, in milliseconds since the epoch. */
  exp: number;
  /** The operation it was made for, so a refusal the proxy logs can be matched to it. */
  sid: string;
  rule: EgressRule;
}

/** Claims for an operation that may run `lifetimeMs`, capped at the longest a token lives. */
export function egressClaimsFor(
  rule: EgressRule,
  lifetimeMs: number,
  now = Date.now(),
): EgressTokenClaims {
  return {
    exp: now + Math.min(lifetimeMs, MAX_EGRESS_TOKEN_MS),
    sid: randomBytes(8).toString('hex'),
    rule: {
      allowedOrigins: [...rule.allowedOrigins],
      privateOrigins: [...rule.privateOrigins],
      allowPrivate: rule.allowPrivate,
    },
  };
}

function mac(key: string, payload: string): Buffer {
  if (key.length < MIN_KEY_LENGTH) throw new Error('the egress signing key is too short');
  return createHmac('sha256', key).update(`lakka-egress.${VERSION}.${payload}`).digest();
}

/** A token: the version, the compressed claims and their MAC, each URL-safe. */
export function signEgressToken(key: string, claims: EgressTokenClaims): string {
  const payload = deflateRawSync(JSON.stringify(claims)).toString('base64url');
  return `${VERSION}.${payload}.${mac(key, payload).toString('base64url')}`;
}

/**
 * The claims of a token made with `key` that has not expired, or null: for a token that is
 * malformed, altered, made with another key, expired, or set to live longer than any may.
 */
export function verifyEgressToken(
  key: string,
  token: string,
  now = Date.now(),
): EgressTokenClaims | null {
  const [version, payload, signature, ...rest] = token.split('.');
  if (version !== VERSION || payload === undefined || signature === undefined || rest.length > 0) {
    return null;
  }
  const expected = mac(key, payload);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      inflateRawSync(Buffer.from(payload, 'base64url'), {
        maxOutputLength: MAX_PAYLOAD_BYTES,
      }).toString('utf8'),
    );
  } catch {
    return null;
  }
  const claims = claimsSchema.safeParse(parsed);
  if (!claims.success) return null;
  const { exp } = claims.data;
  if (exp <= now || exp > now + MAX_EGRESS_TOKEN_MS + CLOCK_ALLOWANCE_MS) return null;
  return claims.data;
}
