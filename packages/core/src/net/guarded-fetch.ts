import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { McpOriginNotAllowedError } from '@lakka/contracts';
import { decideEgress } from './egress-policy.ts';
import type { EgressRule } from './egress-policy.ts';
import {
  lookupWith,
  PrivateAddressError,
  publicOnlyLookupWith,
  systemResolver,
} from './public-address.ts';
import type { Resolver } from './public-address.ts';

/*
 * The only fetch Lakka uses for MCP servers and their authorization servers (NF-S4, ADR 0067,
 * ADR 0117). Every request is checked against the egress rule first (egress-policy.ts): an
 * origin nobody listed is refused before anything is sent. Then:
 *
 * - When the rule says public-only, the address is checked when the connection is made, not when
 *   the URL was saved or listed, so a DNS record changed later cannot point inside the customer's
 *   network.
 * - Redirects are returned, never followed: following one would reach an origin nobody listed,
 *   or an address nobody checked. For any server, an instance admin's too.
 *
 * Responses stream, as Streamable HTTP needs. Connections are pooled per fetch, never shared
 * with other code: a pooled connection is not looked up again, so one made under another rule,
 * such as to a private address for an instance admin's server, must never be reused under this
 * one.
 */

export type GuardedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function toResponse(res: IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    // rawHeaders alternates names and values.
    headers.append(res.rawHeaders[i] as string, res.rawHeaders[i + 1] as string);
  }
  const status = res.statusCode ?? 502;
  const empty = method === 'HEAD' || status === 204 || status === 304;
  if (empty) res.resume();
  return new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
    status,
    statusText: res.statusMessage ?? '',
    headers,
  });
}

/**
 * A fetch that keeps to `rule`. `resolve` replaces the system's name lookup, for tests that
 * cannot use DNS.
 */
export function guardedFetch(rule: EgressRule, resolve?: Resolver): GuardedFetch {
  const publicLookup = publicOnlyLookupWith(resolve ?? systemResolver);
  const anyLookup = resolve === undefined ? undefined : lookupWith(resolve);
  // As Node's global agents are set up: idle connections close after 5 s.
  const agents = {
    http: new HttpAgent({ keepAlive: true, timeout: 5000 }),
    https: new HttpsAgent({ keepAlive: true, timeout: 5000 }),
  };
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const decision = decideEgress(url, rule);
    if (!decision.allowed) {
      if (decision.reason === 'not_http') throw new TypeError('only http and https are allowed');
      if (decision.reason === 'private_address') {
        throw new PrivateAddressError('the host is a private address');
      }
      throw new McpOriginNotAllowedError(decision.origin);
    }
    const lookup = decision.publicOnly ? publicLookup : anyLookup;
    const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolveResponse, reject) => {
      const req = send(
        url,
        {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ...(lookup === undefined ? {} : { lookup }),
          agent: url.protocol === 'https:' ? agents.https : agents.http,
          signal: request.signal,
        },
        (res) => resolveResponse(toResponse(res, request.method)),
      );
      req.on('error', reject);
      req.end(body);
    });
  };
}
