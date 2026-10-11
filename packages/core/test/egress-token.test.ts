import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  egressClaimsFor,
  MAX_EGRESS_TOKEN_MS,
  signEgressToken,
  verifyEgressToken,
} from '../src/net/egress-token.ts';
import type { EgressRule } from '../src/net/egress-policy.ts';

/* The egress proxy's token (NF-S4, ADR 0118): signed by the api, checked by the proxy, short-lived. */

const KEY = randomBytes(32).toString('base64url');
const NOW = 1_800_000_000_000;

const rule: EgressRule = {
  allowedOrigins: ['https://api.example.com', 'http://10.0.0.5:8080'],
  privateOrigins: ['http://10.0.0.5:8080'],
  allowPrivate: true,
};

const token = (lifetimeMs = 30_000) => signEgressToken(KEY, egressClaimsFor(rule, lifetimeMs, NOW));

describe('egress tokens (NF-S4)', () => {
  it('NF-S4: a token carries the rule it was made with, until it expires', () => {
    const claims = verifyEgressToken(KEY, token(), NOW + 1000);
    expect(claims).toMatchObject({ exp: NOW + 30_000, rule });
    expect(claims?.sid).toMatch(/^[0-9a-f]{16}$/);
    expect(token()).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('NF-S4: a token is refused once expired, and never lives longer than 45 s', () => {
    expect(verifyEgressToken(KEY, token(), NOW + 30_000)).toBeNull();
    const long = egressClaimsFor(rule, 10 * 60_000, NOW);
    expect(long.exp).toBe(NOW + MAX_EGRESS_TOKEN_MS);
    // One signed by someone with the key but set to live too long is refused all the same.
    const forged = signEgressToken(KEY, { ...long, exp: NOW + 10 * 60_000 });
    expect(verifyEgressToken(KEY, forged, NOW)).toBeNull();
  });

  it('NF-S4: an altered token, or one signed with another key, is refused', () => {
    const good = token();
    const [version, payload, mac] = good.split('.') as [string, string, string];
    const wider = signEgressToken(randomBytes(32).toString('base64url'), {
      ...egressClaimsFor(rule, 30_000, NOW),
      rule: { ...rule, allowedOrigins: ['https://evil.example.com'] },
    });
    const [, otherPayload] = wider.split('.') as [string, string, string];
    // The MAC is random per run, so the alteration must never be a no-op: a different first
    // character changes the first six bits of the decoded MAC, whatever they were.
    const otherMac = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
    for (const bad of [
      wider,
      `${version}.${otherPayload}.${mac}`,
      `${version}.${payload}.${otherMac}`,
      `v2.${payload}.${mac}`,
      `${version}.${payload}`,
      `${good}.extra`,
      '',
      'not a token',
    ]) {
      expect(verifyEgressToken(KEY, bad, NOW)).toBeNull();
    }
  });

  it('a full allowlist still fits in an environment variable', () => {
    const origins = Array.from({ length: 1000 }, (_, i) => `https://tools-${i}.example.com`);
    const big = signEgressToken(
      KEY,
      egressClaimsFor({ ...rule, allowedOrigins: origins }, 30_000, NOW),
    );
    expect(big.length).toBeLessThan(100_000);
    expect(verifyEgressToken(KEY, big, NOW)?.rule.allowedOrigins).toHaveLength(1000);
  });
});
