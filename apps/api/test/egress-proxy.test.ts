import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, egressClaimsFor, signEgressToken } from '@lakka/core';
import type { EgressRule, Resolver } from '@lakka/core';
import { createEgressProxy } from '../src/sandbox/egress-proxy.ts';

/*
 * The egress proxy (NF-S4, ADR 0118) on loopback: real sockets, a resolver that maps test names
 * to 127.0.0.1, and the proxy told that loopback is not its own, which in the sandbox it is.
 */

const KEY = randomBytes(32).toString('base64url');
const OTHER_KEY = randomBytes(32).toString('base64url');

/** Names the proxy looks up; `alias.test` is another name for the internal `api`. */
const NAMES: Record<string, string> = {
  'listed.test': '127.0.0.1',
  'unlisted.test': '127.0.0.1',
  'alias.test': '127.0.0.2',
  api: '127.0.0.2',
};
const resolve: Resolver = (host, _options, callback) => {
  const address = NAMES[host];
  if (address === undefined) {
    callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }), []);
  } else {
    callback(null, [{ address, family: 4 }]);
  }
};

let target: Server;
let targetPort: number;
let proxy: Server;
let proxyPort: number;
const logs: string[] = [];

const listen = (server: Server) =>
  new Promise<number>((done) =>
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)),
  );

const rule = (extra: Partial<EgressRule> = {}): EgressRule => ({
  allowedOrigins: [`http://listed.test:${targetPort}`, `http://alias.test:${targetPort}`],
  privateOrigins: [],
  allowPrivate: true,
  ...extra,
});

const token = (extra: Partial<EgressRule> = {}, key = KEY, lifetimeMs = 30_000) =>
  signEgressToken(key, egressClaimsFor(rule(extra), lifetimeMs));

const basic = (value: string) => `Basic ${Buffer.from(`t:${value}`).toString('base64')}`;

/** Sends CONNECT and returns the status line, and the socket for what follows. */
function tunnel(authority: string, auth: string | null) {
  return new Promise<{ status: string; socket: ReturnType<typeof connect> }>((done, fail) => {
    const socket = connect(proxyPort, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${
          auth === null ? '' : `Proxy-Authorization: ${auth}\r\n`
        }\r\n`,
      );
    });
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      done({ status: buffered.split('\r\n')[0] ?? '', socket });
    };
    socket.on('data', onData);
    socket.on('error', fail);
  });
}

/** A GET through the proxy in absolute form. */
function viaProxy(url: string, auth: string | null) {
  return new Promise<{ status: number; body: string }>((done, fail) => {
    const socket = connect(proxyPort, '127.0.0.1', () => {
      const host = new URL(url).host;
      socket.write(
        `GET ${url} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${
          auth === null ? '' : `Proxy-Authorization: ${auth}\r\n`
        }\r\n`,
      );
    });
    let text = '';
    socket.on('data', (chunk: Buffer) => (text += chunk.toString()));
    socket.on('end', () =>
      done({
        status: Number(text.split(' ')[1]),
        body: text.slice(text.indexOf('\r\n\r\n') + 4),
      }),
    );
    socket.on('error', fail);
  });
}

beforeAll(async () => {
  target = createServer((req, res) => {
    res.setHeader('connection', 'close');
    res.end(`hello ${req.url} ${req.headers['proxy-authorization'] ?? 'no-auth'}`);
  });
  targetPort = await listen(target);
  const { logger } = createLogger({
    level: 'debug',
    service: 'egress-test',
    destination: { write: (line: string) => void logs.push(line) },
  });
  proxy = createEgressProxy({
    key: () => KEY,
    logger,
    internalHosts: ['api'],
    isOwnAddress: () => false,
    resolve,
  });
  proxyPort = await listen(proxy);
});

afterAll(() => {
  proxy.closeAllConnections();
  proxy.close();
  target.close();
});

describe('the egress proxy (NF-S4)', () => {
  it('NF-S4: tunnels to a listed origin with a valid token', async () => {
    const { status, socket } = await tunnel(`listed.test:${targetPort}`, basic(token()));
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    const body = await new Promise<string>((done) => {
      let text = '';
      socket.on('data', (chunk: Buffer) => (text += chunk.toString()));
      socket.on('end', () => done(text));
      socket.write(`GET /through HTTP/1.1\r\nHost: listed.test\r\nConnection: close\r\n\r\n`);
    });
    // The token stays with the proxy; the server sees none.
    expect(body).toContain('hello /through no-auth');
  });

  it('NF-S4: forwards a plain http request to a listed origin, without the token', async () => {
    const answer = await viaProxy(`http://listed.test:${targetPort}/plain?x=1`, basic(token()));
    expect(answer).toEqual({ status: 200, body: 'hello /plain?x=1 no-auth' });
  });

  it('NF-S4: no token, or a bad one, is 407', async () => {
    const claims = egressClaimsFor(rule(), 30_000);
    for (const auth of [
      null,
      basic(token({}, OTHER_KEY)),
      basic(signEgressToken(KEY, { ...claims, exp: Date.now() - 1 })),
      basic('not-a-token'),
      'Bearer something',
    ]) {
      expect((await tunnel(`listed.test:${targetPort}`, auth)).status).toBe(
        'HTTP/1.1 407 Proxy Authentication Required',
      );
      expect((await viaProxy(`http://listed.test:${targetPort}/`, auth)).status).toBe(407);
    }
  });

  it('NF-S4: an unlisted origin, another port, or a private address the rule does not allow is 403', async () => {
    const auth = basic(token());
    expect((await tunnel(`unlisted.test:${targetPort}`, auth)).status).toBe(
      'HTTP/1.1 403 Forbidden',
    );
    expect((await tunnel(`listed.test:${targetPort + 1}`, auth)).status).toBe(
      'HTTP/1.1 403 Forbidden',
    );
    expect((await viaProxy(`http://unlisted.test:${targetPort}/`, auth)).status).toBe(403);
    // listed.test resolves to loopback, which only a rule that allows private addresses reaches.
    const publicOnly = basic(token({ allowPrivate: false }));
    expect((await tunnel(`listed.test:${targetPort}`, publicOnly)).status).toBe(
      'HTTP/1.1 403 Forbidden',
    );
  });

  it("NF-S4: Lakka's own services are 403 even when listed, by name or by address", async () => {
    const auth = basic(token({ allowedOrigins: [`http://api:${targetPort}`] }));
    expect((await tunnel(`api:${targetPort}`, auth)).status).toBe('HTTP/1.1 403 Forbidden');
    // alias.test is listed, but resolves to where api does.
    expect((await tunnel(`alias.test:${targetPort}`, basic(token()))).status).toBe(
      'HTTP/1.1 403 Forbidden',
    );
  });

  it('NF-S4: a tunnel is cut when its token expires', async () => {
    const { status, socket } = await tunnel(
      `listed.test:${targetPort}`,
      basic(token({}, KEY, 400)),
    );
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    const closed = new Promise<boolean>((done) => socket.on('close', () => done(true)));
    await expect(Promise.race([closed, sleep(3000).then(() => false)])).resolves.toBe(true);
  });

  it("NF-S4: Node's own fetch and http reach a listed origin through it from the environment", async () => {
    const proxyUrl = `http://t:${token()}@127.0.0.1:${proxyPort}`;
    const script = `
      import http from 'node:http';
      const viaFetch = await fetch('http://listed.test:${targetPort}/fetch').then((r) => r.text());
      const viaHttp = await new Promise((done) => http.get('http://listed.test:${targetPort}/http', (r) => {
        let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => done(b));
      }));
      const refused = await fetch('http://unlisted.test:${targetPort}/').then(() => 'reached', () => 'refused');
      console.log(JSON.stringify({ viaFetch, viaHttp, refused }));`;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          NODE_USE_ENV_PROXY: '1',
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      viaFetch: 'hello /fetch no-auth',
      viaHttp: 'hello /http no-auth',
      refused: 'refused',
    });
  });

  it('NF-S5: logs what it refused, as host and port, and never a token', async () => {
    const secret = token();
    await tunnel(`unlisted.test:${targetPort}`, basic(secret));
    const text = logs.join('\n');
    expect(text).toContain('"msg":"egress.refused"');
    expect(text).toContain('"host":"unlisted.test"');
    expect(text).toContain('"error_code":"not_listed"');
    expect(text).toContain('"error_code":"no_token"');
    expect(text).toContain('"error_code":"internal"');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(KEY);
  });

  it('answers its own health check', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
