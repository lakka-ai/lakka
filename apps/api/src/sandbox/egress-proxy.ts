import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect, isIP } from 'node:net';
import type { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import {
  checkProxyAddresses,
  decideProxyEgress,
  LAKKA_SERVICE_HOSTS,
  systemResolver,
  verifyEgressToken,
} from '@lakka/core';
import type { EgressTokenClaims, Logger, ProxyRefusal, ProxyTarget, Resolver } from '@lakka/core';

/*
 * The egress proxy (NF-S4, ADR 0118): the only way out of the sandbox. A stdio server's
 * environment points HTTPS_PROXY and HTTP_PROXY here, with a token the api made for its
 * operation as the password. The proxy takes CONNECT tunnels and plain http requests in absolute
 * form, checks the token, decides with the same policy the api's own MCP traffic keeps to, looks
 * the name up itself, and connects to the address it checked, so a name cannot resolve one way
 * for the check and another for the connection.
 *
 * It keeps no state: everything it knows about an operation is in its token, and a tunnel or
 * request is cut when the token expires. It logs only what it refused, as host and port, never a
 * body, a header or a token (invariant 9).
 *
 *   407  no token, or one that is altered, expired or made with another key
 *   403  an origin or port nobody listed, a private address the rule does not allow, or
 *        Lakka itself
 *   502  a name that does not resolve, or a connection that fails
 */

export const EGRESS_PORT = 3128;
/** A token with a full allowlist is large; Node's default of 16 KB would refuse it. */
const MAX_HEADER_BYTES = 256 * 1024;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface EgressProxyOptions {
  /** The signing key, read for every connection so a regenerated key applies at once. */
  key: () => string | undefined;
  logger: Logger;
  /** Names that are always refused; Lakka's compose services unless a test gives others. */
  internalHosts?: readonly string[];
  /**
   * Whether an address is the proxy's own. By default, every address of this machine and every
   * loopback or unspecified address; tests that need a loopback target replace it.
   */
  isOwnAddress?: (address: string) => boolean;
  /** Replaces the system's name lookup, for tests. */
  resolve?: Resolver;
  now?: () => number;
}

function isLoopbackOrUnspecified(address: string): boolean {
  const bare = address.replace(/^::ffff:/i, '');
  return bare.startsWith('127.') || bare === '0.0.0.0' || address === '::1' || address === '::';
}

/** This machine's addresses, loopback included, looked up each time: they can change. */
export function isThisMachine(address: string): boolean {
  if (isLoopbackOrUnspecified(address)) return true;
  const bare = address.replace(/^::ffff:/i, '').toLowerCase();
  return Object.values(networkInterfaces()).some((list) =>
    (list ?? []).some((info) => info.address.toLowerCase() === bare),
  );
}

function lookupAll(resolve: Resolver, host: string): Promise<string[]> {
  if (isIP(host) !== 0) return Promise.resolve([host]);
  return new Promise((done) =>
    resolve(host, { all: true }, (error, list) =>
      done(error === null ? list.map((entry) => entry.address) : []),
    ),
  );
}

/** The token from a Proxy-Authorization header: Basic, any user name, the token as password. */
function tokenFrom(headers: IncomingHttpHeaders): string | null {
  const header = headers['proxy-authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (match?.[1] === undefined) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1 ? null : decoded.slice(colon + 1);
}

/** Raw headers, names and values alternating, without the hop-by-hop ones. */
function forwardedHeaders(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    if (!HOP_BY_HOP.has(name.toLowerCase())) out.push(name, raw[i + 1] as string);
  }
  return out;
}

export function createEgressProxy(options: EgressProxyOptions): Server {
  const resolve = options.resolve ?? systemResolver;
  const internalHosts = options.internalHosts ?? LAKKA_SERVICE_HOSTS;
  const isOwnAddress = options.isOwnAddress ?? isThisMachine;
  const now = options.now ?? Date.now;

  const claimsFrom = (headers: IncomingHttpHeaders): EgressTokenClaims | null => {
    const token = tokenFrom(headers);
    const key = options.key();
    if (token === null || key === undefined) return null;
    try {
      return verifyEgressToken(key, token, now());
    } catch {
      return null;
    }
  };

  const refused = (
    target: { host: string; port: number },
    reason: ProxyRefusal | 'no_token',
    claims: EgressTokenClaims | null,
  ) => {
    options.logger.warn('egress.refused', {
      host: target.host,
      port: target.port,
      error_code: reason,
      ...(claims === null ? {} : { operation_id: claims.sid }),
    });
  };

  /** Decides a target and looks it up: the address to connect to, or why not. */
  async function admit(
    target: ProxyTarget,
    claims: EgressTokenClaims,
  ): Promise<
    | { ok: true; address: string; port: number }
    | { ok: false; status: 403; reason: ProxyRefusal }
    | { ok: false; status: 502 }
  > {
    const decision = decideProxyEgress(target, claims.rule, internalHosts);
    if (!decision.allowed) return { ok: false, status: 403, reason: decision.reason };
    const addresses = await lookupAll(resolve, decision.host);
    if (addresses.length === 0) return { ok: false, status: 502 };
    // Lakka's services by every address their names have now.
    const internal = (await Promise.all(internalHosts.map((h) => lookupAll(resolve, h)))).flat();
    const refusal = addresses.some(isOwnAddress)
      ? 'internal'
      : checkProxyAddresses(addresses, { publicOnly: decision.publicOnly, refused: internal });
    if (refusal !== null) return { ok: false, status: 403, reason: refusal };
    // Every address passed; the first is the one connected to.
    return { ok: true, address: addresses[0] as string, port: decision.port };
  }

  /** Cuts a connection when its token expires. */
  const expireWith = (claims: EgressTokenClaims, ...streams: Duplex[]) => {
    const timer = setTimeout(
      () => {
        for (const stream of streams) stream.destroy();
      },
      Math.max(0, claims.exp - now()),
    );
    timer.unref();
    for (const stream of streams) stream.once('close', () => clearTimeout(timer));
  };

  async function tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const reply = (status: string, extra = '') =>
      client.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    let host: string;
    let port: number;
    try {
      const url = new URL(`http://${req.url ?? ''}`);
      if (url.pathname !== '/' || url.port === '' || req.url?.includes('/') === true) {
        throw new Error('not an authority');
      }
      host = url.hostname;
      port = Number(url.port);
    } catch {
      reply('400 Bad Request');
      return;
    }
    const claims = claimsFrom(req.headers);
    if (claims === null) {
      refused({ host, port }, 'no_token', null);
      reply(
        '407 Proxy Authentication Required',
        'Proxy-Authenticate: Basic realm="lakka-egress"\r\n',
      );
      return;
    }
    const admitted = await admit({ kind: 'tunnel', host, port }, claims);
    if (!admitted.ok) {
      if (admitted.status === 403) refused({ host, port }, admitted.reason, claims);
      reply(admitted.status === 403 ? '403 Forbidden' : '502 Bad Gateway');
      return;
    }
    const upstream = connect({ host: admitted.address, port: admitted.port });
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!client.destroyed && upstream.connecting) reply('502 Bad Gateway');
      else client.destroy();
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    expireWith(claims, client, upstream);
  }

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const claims = claimsFrom(req.headers);
    if (claims === null) {
      refused({ host: url.hostname, port }, 'no_token', null);
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="lakka-egress"' }).end();
      return;
    }
    const admitted = await admit({ kind: 'request', url }, claims);
    if (!admitted.ok) {
      if (admitted.status === 403) refused({ host: url.hostname, port }, admitted.reason, claims);
      res.writeHead(admitted.status).end();
      return;
    }
    const upstream = httpRequest({
      host: admitted.address,
      port: admitted.port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: forwardedHeaders(req.rawHeaders),
      setHost: false,
      // A fresh connection for every request: one made under another token is never reused.
      agent: false,
    });
    upstream.on('response', (answer) => {
      res.writeHead(
        answer.statusCode ?? 502,
        answer.statusMessage,
        forwardedHeaders(answer.rawHeaders),
      );
      answer.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
    expireWith(claims, req.socket);
  }

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    if (req.url?.startsWith('/') === true) {
      // Origin form is for the proxy itself: only its health.
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      } else {
        res.writeHead(404).end();
      }
      return;
    }
    forward(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
  });
  server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on('error', () => undefined);
    tunnel(req, socket, head).catch(() => socket.destroy());
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}
