import { BlockList, isIP } from 'node:net';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns';

/*
 * Whether an address is on the public internet (ADR 0054). Used for webhooks a workspace admin
 * configures: the worker runs inside the deployment's network, so a webhook pointing at
 * 10.0.0.5, 169.254.169.254 or the database would let a workspace admin reach what they should
 * not. The check runs on the address the name resolves to, at connection time, so a name that
 * later resolves to a private address is refused too.
 */

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is checked as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) return !PRIVATE.check(mapped[1], 'ipv4');
  return !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** A host the URL names directly that is certainly not public: localhost, or a private IP. */
export function isPrivateHostLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIP(host) !== 0 && !isPublicAddress(host);
}

export class PrivateAddressError extends Error {
  readonly code = 'private_address';
}

/** The shape of `dns.lookup` that http.request calls, always with `all: true` here. */
export type Resolver = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export type LookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/** The system's own name lookup. */
export const systemResolver: Resolver = (hostname, options, callback) =>
  dnsLookup(hostname, options, callback);

/**
 * A `lookup` for http.request that refuses to connect to anything but public addresses. The
 * resolver is the system's unless a test gives one.
 */
export function publicOnlyLookupWith(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, list) => {
      if (error !== null) {
        callback(error, []);
        return;
      }
      const safe = list.filter((a) => isPublicAddress(a.address));
      if (safe.length === 0 || safe.length !== list.length) {
        callback(new PrivateAddressError('the host resolves to a private address'), []);
        return;
      }
      if (options.all === true) callback(null, safe);
      else {
        const [first] = safe;
        // safe has at least one entry here.
        callback(null, (first as LookupAddress).address, (first as LookupAddress).family);
      }
    });
  };
}

/** Any address the resolver gives, in the shape http.request wants. */
export function lookupWith(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, list) => {
      if (error !== null) callback(error, []);
      else if (options.all === true) callback(null, list);
      else {
        const [first] = list;
        if (first === undefined)
          callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), []);
        else callback(null, first.address, first.family);
      }
    });
  };
}

/** A `lookup` for http.request that refuses to connect to anything but public addresses. */
export const publicOnlyLookup: LookupFunction = publicOnlyLookupWith(systemResolver);
