import { describe, expect, it } from 'vitest';
import {
  checkProxyAddresses,
  decideProxyEgress,
  LAKKA_SERVICE_HOSTS,
} from '../src/net/egress-proxy-policy.ts';
import type { EgressRule } from '../src/net/egress-policy.ts';

/* What the egress proxy lets a stdio server reach (NF-S4, ADR 0118): pure, no DNS. */

const rule = (extra: Partial<EgressRule> = {}): EgressRule => ({
  allowedOrigins: ['https://api.example.com', 'http://tools.example.com:8080', 'http://api:3000'],
  privateOrigins: [],
  allowPrivate: false,
  ...extra,
});

const tunnel = (host: string, port: number) => ({ kind: 'tunnel' as const, host, port });
const request = (url: string) => ({ kind: 'request' as const, url: new URL(url) });

describe('the egress proxy policy (NF-S4)', () => {
  it('NF-S4: a tunnel or request to a listed origin is allowed, public addresses only', () => {
    expect(decideProxyEgress(tunnel('api.example.com', 443), rule())).toEqual({
      allowed: true,
      host: 'api.example.com',
      port: 443,
      publicOnly: true,
    });
    // A tunnel to a listed http origin: Node's fetch tunnels plain http too.
    expect(decideProxyEgress(tunnel('TOOLS.example.com', 8080), rule())).toMatchObject({
      allowed: true,
      host: 'tools.example.com',
      port: 8080,
    });
    expect(decideProxyEgress(request('http://tools.example.com:8080/x?y=1'), rule())).toMatchObject(
      { allowed: true, port: 8080 },
    );
  });

  it('NF-S4: an unlisted origin, or a listed host on another port, is refused', () => {
    for (const target of [
      tunnel('other.example.com', 443),
      tunnel('api.example.com', 8443),
      tunnel('tools.example.com', 80),
      request('http://tools.example.com/x'),
      request('http://api.example.com/'),
    ]) {
      expect(decideProxyEgress(target, rule())).toEqual({ allowed: false, reason: 'not_listed' });
    }
    // Only plain http is proxied as a request; anything else must be a tunnel.
    expect(decideProxyEgress(request('https://api.example.com/'), rule())).toEqual({
      allowed: false,
      reason: 'bad_target',
    });
    expect(decideProxyEgress(tunnel('api.example.com', 0), rule())).toEqual({
      allowed: false,
      reason: 'bad_target',
    });
  });

  it('NF-S4: a private address is refused unless the server may reach one or it is listed as private', () => {
    const literal = rule({ allowedOrigins: ['http://10.0.0.5:8080'] });
    expect(decideProxyEgress(tunnel('10.0.0.5', 8080), literal)).toEqual({
      allowed: false,
      reason: 'private_address',
    });
    expect(decideProxyEgress(tunnel('10.0.0.5', 8080), { ...literal, allowPrivate: true })).toEqual(
      { allowed: true, host: '10.0.0.5', port: 8080, publicOnly: false },
    );
    expect(
      decideProxyEgress(
        tunnel('10.0.0.5', 8080),
        rule({ allowedOrigins: [], privateOrigins: ['http://10.0.0.5:8080'] }),
      ),
    ).toMatchObject({ allowed: true, publicOnly: false });
    // A name resolving to a private address is refused when the proxy looks it up.
    expect(checkProxyAddresses(['10.0.0.5'], { publicOnly: true, refused: [] })).toBe(
      'private_address',
    );
    expect(checkProxyAddresses(['93.184.216.34'], { publicOnly: true, refused: [] })).toBeNull();
    expect(checkProxyAddresses(['10.0.0.5'], { publicOnly: false, refused: [] })).toBeNull();
  });

  it("NF-S4: Lakka's own services are refused always, by name and by address", () => {
    const everything = rule({
      allowedOrigins: LAKKA_SERVICE_HOSTS.flatMap((h) => [`http://${h}:3000`, `https://${h}`]),
      allowPrivate: true,
    });
    for (const host of LAKKA_SERVICE_HOSTS) {
      expect(decideProxyEgress(tunnel(host, 3000), everything)).toEqual({
        allowed: false,
        reason: 'internal',
      });
      expect(decideProxyEgress(tunnel(`${host.toUpperCase()}.`, 443), everything)).toEqual({
        allowed: false,
        reason: 'internal',
      });
    }
    expect(decideProxyEgress(request('http://api:3000/healthz'), everything)).toEqual({
      allowed: false,
      reason: 'internal',
    });
    // Another name for the same container is refused by the address it resolves to.
    const own = ['172.18.0.4', '172.20.0.2', '127.0.0.1', '::1'];
    for (const address of ['172.18.0.4', '::ffff:172.20.0.2', '127.0.0.1', '::1']) {
      expect(checkProxyAddresses([address], { publicOnly: false, refused: own })).toBe('internal');
    }
    expect(
      checkProxyAddresses(['172.18.0.9', '172.18.0.4'], { publicOnly: false, refused: own }),
    ).toBe('internal');
    expect(checkProxyAddresses([], { publicOnly: false, refused: own })).toBe('bad_target');
  });
});
