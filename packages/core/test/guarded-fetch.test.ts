import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpOriginNotAllowedError } from '@lakka/contracts';
import { classifyMcpFailure } from '../src/mcp/client.ts';
import { guardedFetch } from '../src/net/guarded-fetch.ts';
import { PrivateAddressError } from '../src/net/public-address.ts';
import type { Resolver } from '../src/net/public-address.ts';

/*
 * The fetch for MCP servers and their authorization servers (NF-S4, ADR 0067, ADR 0117). No
 * network and no DNS: names resolve through a fake resolver, and the one server is on loopback.
 */

/** Resolves every name through `table`, as a DNS record would, so a test can change it. */
function fakeResolver(table: Map<string, string>): Resolver & { asked: string[] } {
  const asked: string[] = [];
  const resolve: Resolver = (hostname, _options, callback) => {
    asked.push(hostname);
    const address = table.get(hostname);
    if (address === undefined) {
      callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }), []);
      return;
    }
    const found: LookupAddress = { address, family: address.includes(':') ? 6 : 4 };
    callback(null, [found]);
  };
  return Object.assign(resolve, { asked });
}

let port: number;
const requests: string[] = [];
const server = createServer((req, res) => {
  requests.push(req.url ?? '');
  if (req.url === '/redirect') {
    res.writeHead(302, { location: 'https://elsewhere.example.test/steal' }).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const origin = () => `http://mcp.example.test:${port}`;
const nothing = { allowedOrigins: [], privateOrigins: [], allowPrivate: false };

describe('the guarded fetch (NF-S4)', () => {
  it('NF-S4: refuses an origin that is not listed, before looking it up or connecting', async () => {
    const resolve = fakeResolver(new Map([['mcp.example.test', '127.0.0.1']]));
    const before = requests.length;
    const refused = await guardedFetch(
      { ...nothing, allowPrivate: true, allowedOrigins: ['https://mcp.example.test'] },
      resolve,
    )(`${origin()}/mcp`).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(McpOriginNotAllowedError);
    expect((refused as McpOriginNotAllowedError).origin).toBe(origin());
    expect(classifyMcpFailure(refused)).toBe('not_allowed');
    expect(resolve.asked).toEqual([]);
    expect(requests.length).toBe(before);
  });

  it('NF-S4: reaches a listed origin', async () => {
    const resolve = fakeResolver(new Map([['mcp.example.test', '127.0.0.1']]));
    const fetch = guardedFetch(
      { ...nothing, allowPrivate: true, allowedOrigins: [origin()] },
      resolve,
    );
    const res = await fetch(`${origin()}/mcp`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(resolve.asked).toEqual(['mcp.example.test']);
  });

  it('NF-S4: a redirect to another origin is returned, not followed', async () => {
    const resolve = fakeResolver(
      new Map([
        ['mcp.example.test', '127.0.0.1'],
        ['elsewhere.example.test', '127.0.0.1'],
      ]),
    );
    const fetch = guardedFetch(
      {
        ...nothing,
        allowPrivate: true,
        allowedOrigins: [origin(), 'https://elsewhere.example.test'],
      },
      resolve,
    );
    const before = requests.length;
    const res = await fetch(`${origin()}/redirect`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://elsewhere.example.test/steal');
    expect(requests.slice(before)).toEqual(['/redirect']);
    expect(resolve.asked).toEqual(['mcp.example.test']);
  });

  it('NF-S4: a private address needs the private listing even when the origin is listed', async () => {
    const resolve = fakeResolver(new Map([['mcp.example.test', '127.0.0.1']]));
    const before = requests.length;
    // A workspace admin's server: listed, but public-only.
    const listedOnly = await guardedFetch(
      { ...nothing, allowedOrigins: [origin()] },
      resolve,
    )(`${origin()}/mcp`).catch((e: unknown) => e);
    expect(listedOnly).toBeInstanceOf(PrivateAddressError);
    expect(classifyMcpFailure(listedOnly)).toBe('unreachable');
    expect(requests.length).toBe(before);
    // Listed by the operator as private: reached.
    const res = await guardedFetch(
      { ...nothing, privateOrigins: [origin()] },
      resolve,
    )(`${origin()}/mcp`);
    expect(res.status).toBe(200);
  });

  it('NF-S4: a connection made under one rule is never reused under another', async () => {
    const resolve = fakeResolver(new Map([['mcp.example.test', '127.0.0.1']]));
    // An instance admin's server: the connection to loopback is made, and kept alive.
    const res = await guardedFetch(
      { ...nothing, allowPrivate: true, allowedOrigins: [origin()] },
      resolve,
    )(`${origin()}/mcp`);
    expect(await res.text()).toBe('hello');
    // A workspace admin's server at the same origin looks the name up afresh, and is refused.
    const before = requests.length;
    await expect(
      guardedFetch({ ...nothing, allowedOrigins: [origin()] }, resolve)(`${origin()}/mcp`),
    ).rejects.toBeInstanceOf(PrivateAddressError);
    expect(requests.length).toBe(before);
  });

  it('NF-S4: a name that resolves somewhere private later is still refused', async () => {
    const table = new Map([['mcp.example.test', '203.0.113.10']]);
    const resolve = fakeResolver(table);
    const fetch = guardedFetch({ ...nothing, allowedOrigins: [origin()] }, resolve);
    // The record changes after the origin was listed.
    table.set('mcp.example.test', '127.0.0.1');
    const before = requests.length;
    await expect(fetch(`${origin()}/mcp`)).rejects.toMatchObject({ code: 'private_address' });
    expect(requests.length).toBe(before);
  });

  it('refuses private and loopback addresses written in the URL, listed or not', async () => {
    for (const url of [
      'http://127.0.0.1:4010/mcp',
      'https://10.1.2.3/mcp',
      'https://[::1]/mcp',
      'https://169.254.169.254/latest/meta-data',
      'https://[::ffff:192.168.0.1]/mcp',
      'http://localhost:4010/mcp',
    ]) {
      const listed = new URL(url).origin;
      await expect(
        guardedFetch({ ...nothing, allowedOrigins: [listed] })(url),
      ).rejects.toBeInstanceOf(PrivateAddressError);
    }
  });

  it('refuses anything but http and https', async () => {
    await expect(guardedFetch(nothing)('file:///etc/passwd')).rejects.toBeInstanceOf(TypeError);
  });
});
