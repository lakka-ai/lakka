import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postWebhook } from '../src/budgets/alerts.ts';
import { PrivateAddressError } from '../src/net/public-address.ts';

/*
 * Budget alert deliveries (BG-10, ADR 0054). An instance admin's webhook may point anywhere; a
 * workspace admin's may only reach public addresses. No network: one server on loopback, reached
 * as `localhost`, which the public-only lookup refuses.
 */

let port: number;
let received = 0;
const server = createServer((req, res) => {
  received += 1;
  req.resume();
  // Keep-alive, so a pooled client would keep the socket for the next delivery.
  res.writeHead(204, { connection: 'keep-alive' }).end();
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('webhook deliveries (BG-10, NF-S4)', () => {
  it('BG-10, NF-S4: a connection made for an instance webhook is never reused by a workspace one', async () => {
    const url = `http://localhost:${port}/hook`;
    // An instance admin's webhook on this machine: delivered.
    expect(await postWebhook(url, '{}', {}, false)).toBe(204);
    // A workspace admin's webhook at the same address looks the name up afresh, and is refused.
    const before = received;
    await expect(postWebhook(url, '{}', {}, true)).rejects.toBeInstanceOf(PrivateAddressError);
    expect(received).toBe(before);
  });
});
