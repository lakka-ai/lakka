import { describe, expect, it } from 'vitest';
import { decideEgress, normaliseOrigin } from '../src/net/egress-policy.ts';
import type { EgressRule } from '../src/net/egress-policy.ts';

/* Where MCP traffic may go (NF-S4, ADR 0117): one pure function, no DNS. */

const LISTED = 'https://mcp.example.com';
const PRIVATE = 'http://10.0.0.5:8080';

const rule = (extra: Partial<EgressRule> = {}): EgressRule => ({
  allowedOrigins: [LISTED, 'http://127.0.0.1:4010'],
  privateOrigins: [PRIVATE],
  allowPrivate: false,
  ...extra,
});

describe('the egress policy (NF-S4)', () => {
  it('NF-S4: normalises an origin one way: lowercase, ASCII host, no default port', () => {
    expect(normaliseOrigin('HTTPS://MCP.Example.COM:443/some/path?q=1')).toBe(LISTED);
    expect(normaliseOrigin('http://example.com:80/')).toBe('http://example.com');
    expect(normaliseOrigin('http://example.com:8080')).toBe('http://example.com:8080');
    expect(normaliseOrigin('https://b\u00fccher.example/')).toBe('https://xn--bcher-kva.example');
    expect(normaliseOrigin('http://[::1]:4010/mcp')).toBe('http://[::1]:4010');
    expect(normaliseOrigin('file:///etc/passwd')).toBeNull();
    expect(normaliseOrigin('not a url')).toBeNull();
  });

  it.each([
    // url, rule, decision
    ['https://mcp.example.com/mcp', {}, { allowed: true, origin: LISTED, publicOnly: true }],
    ['HTTPS://mcp.EXAMPLE.com:443/x', {}, { allowed: true, origin: LISTED, publicOnly: true }],
    [
      'https://other.example.com/mcp',
      {},
      { allowed: false, origin: 'https://other.example.com', reason: 'not_listed' },
    ],
    // Same host, another port or scheme, is another origin.
    [
      'https://mcp.example.com:8443/mcp',
      {},
      { allowed: false, origin: 'https://mcp.example.com:8443', reason: 'not_listed' },
    ],
    [
      'http://mcp.example.com/mcp',
      {},
      { allowed: false, origin: 'http://mcp.example.com', reason: 'not_listed' },
    ],
    // No wildcards: a subdomain is not its parent.
    [
      'https://a.mcp.example.com/mcp',
      {},
      { allowed: false, origin: 'https://a.mcp.example.com', reason: 'not_listed' },
    ],
    ['file:///etc/passwd', {}, { allowed: false, origin: null, reason: 'not_http' }],
    // Listed, but a private address needs the operator's private listing...
    [
      'http://127.0.0.1:4010/mcp',
      {},
      { allowed: false, origin: 'http://127.0.0.1:4010', reason: 'private_address' },
    ],
    // ...unless it is an instance admin's server.
    [
      'http://127.0.0.1:4010/mcp',
      { allowPrivate: true },
      { allowed: true, origin: 'http://127.0.0.1:4010', publicOnly: false },
    ],
    // The operator's private origins count as listed, and may be private.
    ['http://10.0.0.5:8080/mcp', {}, { allowed: true, origin: PRIVATE, publicOnly: false }],
    // An instance admin's server still needs its origin listed.
    [
      'http://192.168.1.2/mcp',
      { allowPrivate: true },
      { allowed: false, origin: 'http://192.168.1.2', reason: 'not_listed' },
    ],
    // An instance admin's server reaches a listed name wherever it resolves.
    [
      'https://mcp.example.com/',
      { allowPrivate: true },
      { allowed: true, origin: LISTED, publicOnly: false },
    ],
  ] as const)('NF-S4: %s', (url, extra, decision) => {
    expect(decideEgress(url, rule(extra))).toEqual(decision);
  });

  it('NF-S4: an empty list allows nothing', () => {
    expect(
      decideEgress(LISTED, { allowedOrigins: [], privateOrigins: [], allowPrivate: true }),
    ).toEqual({ allowed: false, origin: LISTED, reason: 'not_listed' });
  });
});
