import { isIP } from 'node:net';
import { decideEgress } from './egress-policy.ts';
import type { EgressRule } from './egress-policy.ts';
import { isPublicAddress } from './public-address.ts';

/*
 * What the egress proxy lets a stdio server reach (NF-S4, ADR 0118). The same decideEgress the
 * api's guarded fetch uses decides whether an origin is listed, and whether its name must
 * resolve to public addresses. On top of that, the proxy never reaches Lakka itself: its own
 * services, by name and by every address their names resolve to, and the proxy's own addresses.
 * Those are looked up for every connection, since a container's address changes when it is
 * recreated. Pure: the proxy does the lookups and passes the results in.
 *
 * A server asks for one of two things:
 * - a tunnel (CONNECT host:port). What runs inside it is opaque, so it is allowed when the http
 *   or the https origin of that host and port is listed: Node's fetch tunnels plain http too.
 * - a plain http request in absolute form, decided by its own origin.
 */

/** The compose services of a Lakka stack, which no tool may reach through the proxy. */
export const LAKKA_SERVICE_HOSTS: readonly string[] = [
  'postgres',
  'valkey',
  'api',
  'worker',
  'web',
  'caddy',
  'sandbox',
  'egress',
  'init',
];

export type ProxyTarget =
  | { kind: 'tunnel'; host: string; port: number }
  | { kind: 'request'; url: URL };

export type ProxyRefusal = 'not_listed' | 'private_address' | 'internal' | 'bad_target';

export type ProxyDecision =
  | {
      allowed: true;
      /** The name or address to look up, without brackets. */
      host: string;
      port: number;
      /** Every address the name resolves to must be public. */
      publicOnly: boolean;
    }
  | { allowed: false; reason: ProxyRefusal };

/** A host as compared with the service names: lowercase, no trailing dot, no brackets. */
function bareHost(host: string): string {
  return host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

/** Whether the host is one of Lakka's own services, by name. */
export function isInternalHost(host: string, internalHosts = LAKKA_SERVICE_HOSTS): boolean {
  return internalHosts.includes(bareHost(host));
}

export function decideProxyEgress(
  target: ProxyTarget,
  rule: EgressRule,
  internalHosts = LAKKA_SERVICE_HOSTS,
): ProxyDecision {
  let urls: URL[];
  if (target.kind === 'tunnel') {
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      return { allowed: false, reason: 'bad_target' };
    }
    const host = isIP(bareHost(target.host)) === 6 ? `[${bareHost(target.host)}]` : target.host;
    try {
      urls = [new URL(`https://${host}:${target.port}`), new URL(`http://${host}:${target.port}`)];
    } catch {
      return { allowed: false, reason: 'bad_target' };
    }
  } else {
    if (target.url.protocol !== 'http:') return { allowed: false, reason: 'bad_target' };
    urls = [target.url];
  }
  const first = urls[0] as URL;
  const host = bareHost(first.hostname);
  if (isInternalHost(host, internalHosts)) return { allowed: false, reason: 'internal' };
  const decisions = urls.map((url) => decideEgress(url, rule));
  const allowed = decisions.filter((d) => d.allowed);
  if (allowed.length === 0) {
    const privateRefusal = decisions.some((d) => !d.allowed && d.reason === 'private_address');
    return { allowed: false, reason: privateRefusal ? 'private_address' : 'not_listed' };
  }
  const port =
    target.kind === 'tunnel'
      ? target.port
      : Number(first.port || (first.protocol === 'https:' ? 443 : 80));
  // The tunnel reaches one host and port whichever origin listed it; the more open listing wins.
  return { allowed: true, host, port, publicOnly: allowed.every((d) => d.publicOnly) };
}

/** IPv4 written as IPv6 is compared as IPv4. */
function canonicalAddress(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return (mapped?.[1] ?? address).toLowerCase();
}

/**
 * Whether the addresses a target resolved to may be reached: none may be one of `refused`
 * (Lakka's services and the proxy itself), and with `publicOnly`, every one must be public.
 */
export function checkProxyAddresses(
  addresses: readonly string[],
  options: { publicOnly: boolean; refused: Iterable<string> },
): ProxyRefusal | null {
  if (addresses.length === 0) return 'bad_target';
  const refused = new Set([...options.refused].map(canonicalAddress));
  if (addresses.some((a) => refused.has(canonicalAddress(a)))) return 'internal';
  if (options.publicOnly && !addresses.every((a) => isPublicAddress(a))) return 'private_address';
  return null;
}
