import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, runnerListRequestFor, runnerRequestFor } from '@lakka/core';
import type { LogFields, Logger, McpTarget } from '@lakka/core';
import { SlotPool } from '../src/sandbox/slots.ts';
import { createToolHost } from '../src/sandbox/tool-host.ts';
import type { ToolHost } from '../src/sandbox/tool-host.ts';

/*
 * The tool host (NF-S4, ADR 0118) on loopback, below root: slots share this process's uid, so
 * this checks the protocol, the deadlines and the queue. The stack test (pnpm test:sandbox)
 * checks the uids and limits in the real container.
 */

const TOKEN = randomBytes(32).toString('base64url');
const RUNNER = fileURLToPath(new URL('../src/cli/tool-runner.ts', import.meta.url));
const STDIO_SERVER = fileURLToPath(
  new URL('../../../test/integration/mcp-plain-stdio.ts', import.meta.url),
);
/** A runner that writes its pid where it is told, then never answers. */
const HANG = [
  process.execPath,
  '-e',
  "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
] as const;

const target: McpTarget = {
  transport: 'stdio',
  url: null,
  command: process.execPath,
  args: [STDIO_SERVER],
  credentialEnv: null,
  allowPrivate: true,
  allowedOrigins: [],
  privateOrigins: [],
};
const call = (toolName: string, args: Record<string, unknown> = {}, timeoutMs = 10_000) =>
  runnerRequestFor({ target, secret: null, toolName, arguments: args, timeoutMs });

const hosts: ToolHost[] = [];
const { logger } = createLogger({ level: 'silent', service: 'tool-host-test' });

/** A logger that keeps its warnings, to check what a failure leaves behind. */
function recording(): { log: Logger; warnings: { event: string; fields?: LogFields }[] } {
  const warnings: { event: string; fields?: LogFields }[] = [];
  const log: Logger = {
    ...logger,
    warn: (event, fields) => {
      warnings.push(fields === undefined ? { event } : { event, fields });
    },
    child: () => log,
  };
  return { log, warnings };
}

async function start(
  runner: readonly [string, ...string[]],
  count = 2,
  startAllowanceMs = 15_000,
  log: Logger = logger,
): Promise<{ url: string; host: ToolHost }> {
  const slots = new SlotPool({
    count,
    root: mkdtempSync(join(tmpdir(), 'lakka-slots-')),
    switchUser: false,
    logger,
  });
  await slots.prepare();
  const host = createToolHost({ token: () => TOKEN, slots, runner, logger: log, startAllowanceMs });
  hosts.push(host);
  await new Promise<void>((done) => host.server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`, host };
}

function post(url: string, body: string, token: string | null = TOKEN, signal?: AbortSignal) {
  return fetch(`${url}/operations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body,
    ...(signal === undefined ? {} : { signal }),
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 100 && !existsSync(file); i += 1) await sleep(50);
  return Number(readFileSync(file, 'utf8'));
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.stop();
    host.server.closeAllConnections();
    host.server.close();
  }
});

describe('the tool host (NF-S4)', () => {
  it('NF-S4: refuses an operation without its token, or with another', async () => {
    const { url, host } = await start([process.execPath, RUNNER]);
    expect((await post(url, call('echo', { text: 'x' }), null)).status).toBe(401);
    expect((await post(url, call('echo', { text: 'x' }), 'not-the-token')).status).toBe(401);
    expect((await post(url, '{"version":3}')).status).toBe(400);
    expect(host.operations).toBe(0);
  });

  it('TL-8: runs a call and a listing in a fresh runner, and passes its reply back', async () => {
    const { url, host } = await start([process.execPath, RUNNER]);
    const called = await post(url, call('echo', { text: 'hi' }));
    expect(called.status).toBe(200);
    expect(await called.json()).toEqual({
      ok: true,
      result: { content: [{ type: 'text', text: 'hi' }] },
    });
    const listed = await post(
      url,
      runnerListRequestFor({ target, secret: null, timeoutMs: 10_000 }),
    );
    expect(((await listed.json()) as { tools: { name: string }[] }).tools[0]?.name).toBe('echo');
    expect(host.operations).toBe(2);
  });

  it('NF-S4: a runner that dies on its own is logged with how it exited, never with its output', async () => {
    const { log, warnings } = recording();
    const dies = [
      process.execPath,
      '-e',
      "process.stderr.write('server output'); process.exit(3)",
    ] as const;
    const { url } = await start(dies, 1, 15_000, log);
    await (await post(url, call('echo'))).text();
    expect(warnings).toEqual([
      { event: 'sandbox.runner_exited', fields: { slot: null, exit_code: 3, signal: null } },
    ]);
  });

  it('NF-S4: an operation past its deadline is 504, and its runner is ended', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'lakka-pid-')), 'pid');
    const { url } = await start([...HANG, pidFile], 1, 300);
    const res = await post(url, call('echo', {}, 200));
    expect(res.status).toBe(504);
    const pid = await pidFrom(pidFile);
    for (let i = 0; i < 40 && alive(pid); i += 1) await sleep(50);
    expect(alive(pid)).toBe(false);
  });

  it('NF-S4: when the api goes away, its operation is ended', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'lakka-pid-')), 'pid');
    const { url } = await start([...HANG, pidFile], 1);
    const controller = new AbortController();
    const pending = post(url, call('echo'), TOKEN, controller.signal).catch((e: unknown) => e);
    const pid = await pidFrom(pidFile);
    expect(alive(pid)).toBe(true);
    controller.abort();
    await pending;
    for (let i = 0; i < 40 && alive(pid); i += 1) await sleep(50);
    expect(alive(pid)).toBe(false);
  });

  it('NF-S4: with every slot busy, an operation waits, then is 503 at its deadline', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'lakka-pid-')), 'pid');
    const { url, host } = await start([...HANG, pidFile], 1, 300);
    const first = post(url, call('echo', {}, 2000));
    await pidFrom(pidFile);
    const waited = Date.now();
    const second = await post(url, call('echo', {}, 100));
    expect(second.status).toBe(503);
    expect(Date.now() - waited).toBeGreaterThanOrEqual(350);
    expect((await first).status).toBe(504);
    // The slot is free again once the first is cleaned up.
    expect(host.operations).toBe(1);
    const health = (await (await fetch(`${url}/healthz`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: 'ok', slots: 1, usable: 1, free: 1, waiting: 0 });
  });

  it('a request that is too large is refused before it takes a slot', async () => {
    const { url, host } = await start([process.execPath, RUNNER]);
    const res = await new Promise<number>((done, fail) => {
      const req = httpRequest(
        `${url}/operations`,
        { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } },
        (r) => {
          r.resume();
          done(r.statusCode ?? 0);
        },
      );
      req.on('error', fail);
      req.end(Buffer.alloc(2 * 1024 * 1024, 'x'));
    });
    expect(res).toBe(413);
    expect(host.operations).toBe(0);
  });
});
