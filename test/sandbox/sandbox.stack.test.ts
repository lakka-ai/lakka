import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../stack.ts';

/*
 * The stdio sandbox in the real stack (NF-S4, ADR 0118): compose.yaml with docker/compose.e2e.yaml,
 * which mounts the probe (probe-server.ts) into the sandbox and runs the fake provider, whose
 * two ports stand in for a listed origin (4010) and an unlisted one (4011). Every operation goes
 * the production way: chat through Caddy, the api's dispatch seam, the tool host, a runner under
 * a slot's uid, the probe, and the egress proxy.
 *
 *   docker compose -f compose.yaml -f docker/compose.e2e.yaml up -d --build --wait
 *   pnpm test:sandbox
 *
 * The failure-injection tests stop and kill services, and start them again before they finish.
 */

const BASE = process.env['LAKKA_E2E_URL'] ?? 'http://127.0.0.1:8080';
const FAKE_PROVIDER_URL = 'http://fake-provider:4010/openai/v1';
const LISTED = 'http://fake-provider:4010';
const UNLISTED_ORIGIN = 'http://fake-provider:4011';
const UNLISTED_URL = `${UNLISTED_ORIGIN}/mcp`;
const FIRST_SLOT = 61_000;
const LAST_SLOT = 61_063;

const tag = randomBytes(3).toString('hex');
let cookie = '';
let workspaceId = '';
let stdioServer = { id: '', name: '' };
let httpServer = { id: '', name: '' };
const models: Record<string, string> = {};

function compose(...args: string[]): string {
  return execFileSync(
    'docker',
    ['compose', '-f', 'compose.yaml', '-f', 'docker/compose.e2e.yaml', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** A service's container's addresses, on every network it is on. */
function addressesOf(service: string): string[] {
  const id = compose('ps', '-q', service);
  return execFileSync(
    'docker',
    ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', id],
    { encoding: 'utf8' },
  )
    .trim()
    .split(/\s+/)
    .filter((a) => a !== '');
}

/** Live processes in the sandbox under a slot's uid. */
function slotProcesses(): number {
  const script = `
    const fs = require('node:fs');
    let n = 0;
    for (const p of fs.readdirSync('/proc')) {
      if (!/^\\d+$/.test(p)) continue;
      try {
        const s = fs.readFileSync('/proc/' + p + '/status', 'utf8');
        const uid = Number(/^Uid:\\s+(\\d+)/m.exec(s)[1]);
        if (uid >= ${FIRST_SLOT} && uid <= ${LAST_SLOT} && !/^State:\\s+Z/m.test(s)) n += 1;
      } catch {}
    }
    console.log(n);`;
  return Number(compose('exec', '-T', 'sandbox', 'node', '-e', script));
}

async function healthy(service: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    const id = compose('ps', '-q', service);
    if (id !== '') {
      const status = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', id], {
        encoding: 'utf8',
      }).trim();
      if (status === 'healthy') return;
    }
    await sleep(1000);
  }
  throw new Error(`${service} did not become healthy`);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const ws = () => `/api/workspaces/${workspaceId}`;

/** Runs one of the probe's tools from chat; the tool's own text, and the request's id. */
async function runTool(tool: string): Promise<{ requestId: string; text: string }> {
  const conversation = await call<{ conversation: { id: string } }>(
    'POST',
    `${ws()}/conversations`,
    {},
  );
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin: BASE,
      'x-lakka-workspace': workspaceId,
      'x-lakka-conversation': conversation.conversation.id,
    },
    body: JSON.stringify({
      model: models[tool],
      max_tokens: 100,
      messages: [{ role: 'user', content: `Run ${tool}.` }],
    }),
  });
  if (res.status !== 200) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
  const requestId = res.headers.get('x-lakka-request-id') ?? '';
  await res.json();
  const view = await call<{ conversation: { messages: { role: string; content: string }[] } }>(
    'GET',
    `${ws()}/conversations/${conversation.conversation.id}`,
  );
  const text = view.conversation.messages.find((m) => m.role === 'tool')?.content ?? '';
  return { requestId, text };
}

async function probe(): Promise<Probe> {
  const { text } = await runTool('probe');
  return JSON.parse(text) as Probe;
}

interface Probe {
  uid: number;
  gid: number;
  groups: number[];
  env: string[];
  files: Record<string, string>;
  writes: Record<string, string>;
  dns: Record<string, string>;
  direct: Record<string, string>;
  proxied: { listed: string; unlisted: string; internal: string };
  proxiedHttp: { listed: string; unlisted: string; internal: string };
  ignoringProxy: string;
  others: { uid: number; environ: string }[];
  limits: { processes: string; data: string };
}

const testServer = (id: string) =>
  call<{ status: string; tools: unknown[] }>('POST', `${ws()}/mcp-servers/${id}/test`, {});

const isAddress = (value: string | undefined) => /^[0-9a-f.:]+$/i.test(value ?? '') && value !== '';

beforeAll(async () => {
  const email = `sandbox-${tag}@example.com`;
  const password = `sandbox password ${tag}`;
  createUser(email, 'Sandbox Admin', password, true);
  const signedIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (!signedIn.ok) throw new Error(`sign-in failed: ${signedIn.status}`);
  cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  workspaceId = (
    await call<{ workspace: { id: string } }>('POST', '/api/workspaces', {
      name: 'Sandbox',
      slug: `sandbox-${tag}`,
    })
  ).workspace.id;
  // A cap, so every request reserves and settles (BG-2).
  await call('PUT', `${ws()}/budgets/workspace`, { limitMicroUsd: '100000000', period: 'monthly' });
  const provider = `sandbox-${tag}`;
  await call('POST', '/api/providers', {
    kind: 'openai-compatible',
    name: provider,
    baseUrl: FAKE_PROVIDER_URL,
  });
  for (const tool of ['probe', 'hold', 'leave', 'exhaust']) {
    models[tool] = (
      await call<{ model: { id: string } }>('POST', '/api/models/custom', {
        provider,
        model: `tool-${tool}~${tag}`,
        contextWindow: 100_000,
        maxOutputTokens: 4096,
        capabilities: {
          vision: false,
          pdf: false,
          tools: true,
          structuredOutput: false,
          promptCaching: false,
          reasoning: false,
        },
        prices: {
          inputMicroUsdPerMtok: 1_000_000,
          outputMicroUsdPerMtok: 2_000_000,
          cacheReadMicroUsdPerMtok: null,
          cacheWriteMicroUsdPerMtok: null,
        },
      })
    ).model.id;
  }

  // The listed origin, and the api itself, listed, which the proxy must refuse all the same. The
  // unlisted one may be listed from an earlier run: the list is the instance's.
  for (const origin of [LISTED, 'http://api:3000']) {
    await call('POST', '/api/admin/mcp-origins', { origin });
  }
  await fetch(`${BASE}/api/admin/mcp-origins?origin=${encodeURIComponent(UNLISTED_ORIGIN)}`, {
    method: 'DELETE',
    headers: { origin: BASE, cookie },
  });

  // Where the probe tries to go without the proxy: Lakka's services and the listed origin.
  const direct = [
    ...addressesOf('postgres').map((a) => `${a}:5432`),
    ...addressesOf('valkey').map((a) => `${a}:6379`),
    ...addressesOf('api').map((a) => `${a}:3000`),
    ...addressesOf('fake-provider').map((a) => `${a}:4010`),
  ];
  stdioServer = (
    await call<{ server: { id: string; name: string } }>('POST', `${ws()}/mcp-servers`, {
      transport: 'stdio',
      name: `probe${tag}`,
      command: 'node',
      args: [
        '/probe/probe-server.ts',
        '--listed',
        `${LISTED}/openai/v1/models`,
        '--unlisted',
        UNLISTED_URL,
        '--internal',
        'http://api:3000/healthz',
        '--direct',
        direct.join(','),
        '--outside',
        'example.com',
        '--hold-ms',
        '20000',
      ],
      authMode: 'none',
    })
  ).server;
  const synced = await call<{ tools: { id: string }[] }>(
    'POST',
    `${ws()}/mcp-servers/${stdioServer.id}/tools/sync`,
    {},
  );
  for (const tool of synced.tools) {
    await call('PATCH', `${ws()}/tools/${tool.id}`, { enabled: true });
  }
});

afterAll(async () => {
  // Whatever a failed test left stopped is started again for the steps after this suite.
  compose('start', 'sandbox', 'egress');
  await healthy('sandbox');
  await healthy('egress');
});

describe('the stdio sandbox (NF-S4)', () => {
  let report: Probe;

  beforeAll(async () => {
    report = await probe();
    // What the probe saw, in the log: names and error codes, no values.
    process.stdout.write(`sandbox: the probe saw ${JSON.stringify(report)}\n`);
  });

  it('NF-S4: a stdio server runs under a slot uid of its own, with no groups of ours', () => {
    expect(report.uid).toBeGreaterThanOrEqual(FIRST_SLOT);
    expect(report.uid).toBeLessThanOrEqual(LAST_SLOT);
    expect(report.gid).toBe(report.uid);
    expect(report.groups).toEqual([report.uid]);
  });

  it('NF-S4: it cannot read the secrets, the sandbox keys or the tool host socket', () => {
    expect(report.files).toEqual({
      secrets: 'ENOENT',
      authSecret: 'ENOENT',
      sandboxKeys: 'EACCES',
      toolHostToken: 'EACCES',
      egressKey: 'ENOENT',
      toolHostSocket: 'EACCES',
    });
  });

  it('NF-S4: it sees no LAKKA_ variable, only what a server needs and the proxy', () => {
    expect(report.env).toEqual([
      'HOME',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NODE_USE_ENV_PROXY',
      'PATH',
      'TMPDIR',
      'http_proxy',
      'https_proxy',
    ]);
  });

  it('NF-S4: it can write only in its own home', () => {
    expect(report.writes.home).toBe('written');
    expect(report.writes.tmp).toBe('EACCES');
    expect(report.writes.shm).toBe('EACCES');
    expect(['EROFS', 'EACCES']).toContain(report.writes.root);
  });

  it('NF-S4: it cannot connect to postgres, valkey or the api, by name or by address', () => {
    for (const name of ['postgres', 'valkey', 'api'])
      expect(isAddress(report.dns[name])).toBe(false);
    expect(Object.keys(report.direct).length).toBeGreaterThanOrEqual(4);
    for (const [target, result] of Object.entries(report.direct)) {
      expect({ target, result }).not.toEqual({ target, result: 'connected' });
    }
    // Listed or not, the proxy never reaches Lakka itself.
    expect(report.proxied.internal).not.toBe('200');
    expect(report.proxiedHttp.internal).toBe('403');
  });

  it('NF-S4: it cannot resolve names outside (Docker Engine 26 and later)', () => {
    expect(isAddress(report.dns['outside'])).toBe(false);
    // The proxy's own name resolves: it is on the sandbox's network.
    expect(isAddress(report.dns['egress'])).toBe(true);
    // The same for any process in the container, not only the probe's.
    const lookup = compose(
      'exec',
      '-T',
      'sandbox',
      'node',
      '-e',
      "require('node:dns').lookup('example.com', (e) => console.log(e ? e.code : 'resolved'))",
    );
    expect(lookup).not.toBe('resolved');
  });

  it('NF-S4: it reaches a listed origin through the egress proxy, and not an unlisted one', () => {
    // fetch tunnels; the http module sends absolute form, and hears the proxy's own 403.
    expect(report.proxied.listed).toBe('200');
    expect(report.proxiedHttp.listed).toBe('200');
    expect(report.proxied.unlisted).not.toMatch(/^\d{3}$/);
    expect(report.proxiedHttp.unlisted).toBe('403');
  });

  it('NF-S4: a process that ignores the proxy has no network', () => {
    expect(report.ignoringProxy).not.toBe('200');
    expect(report.ignoringProxy).not.toBe('');
  });

  it('NF-S4: it runs under its process and memory limits', () => {
    expect(report.limits).toEqual({ processes: '64', data: String(1024 * 1024 * 1024) });
  });

  it("NF-S4: it cannot read a concurrent operation's environment", async () => {
    const held = runTool('hold');
    for (let i = 0; i < 30 && slotProcesses() === 0; i += 1) await sleep(500);
    const during = await probe();
    const otherSlots = during.others.filter((p) => p.uid >= FIRST_SLOT && p.uid <= LAST_SLOT);
    // The held operation's runner and server, under another slot's uid.
    expect(otherSlots.length).toBeGreaterThan(0);
    expect(during.others.filter((p) => p.environ === 'read')).toEqual([]);
    expect(JSON.parse((await held).text)).toEqual({ held: true });
  });

  it('NF-S4: an operation leaves no process behind', async () => {
    const { text } = await runTool('leave');
    expect((JSON.parse(text) as { pid: number }).pid).toBeGreaterThan(0);
    for (let i = 0; i < 20 && slotProcesses() > 0; i += 1) await sleep(250);
    expect(slotProcesses()).toBe(0);
  });

  it('NF-S4: an operation is capped at its limits, and the sandbox and the api stay healthy', async () => {
    const result = JSON.parse((await runTool('exhaust')).text) as {
      bigAllocExit: number | null;
      spawned: number;
      firstError: string;
    };
    expect(result.bigAllocExit).not.toBe(0);
    expect(result.spawned).toBeLessThan(64);
    expect(result.firstError).toBe('EAGAIN');
    for (let i = 0; i < 20 && slotProcesses() > 0; i += 1) await sleep(250);
    expect(slotProcesses()).toBe(0);
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    await healthy('sandbox');
    expect((await probe()).proxied.listed).toBe('200');
  });

  it('NF-S4: a runner starts quickly enough for every operation to have its own', async () => {
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      expect((await testServer(stdioServer.id)).status).toBe('ok');
      times.push(performance.now() - started);
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    process.stdout.write(
      `sandbox: listing a stdio server's tools through the sandbox took ${times
        .map((t) => Math.round(t))
        .join(', ')} ms (mean ${Math.round(mean)} ms)\n`,
    );
    expect(mean).toBeLessThan(5000);
  });
});

describe('the sandbox failing (NF-S4)', () => {
  beforeAll(async () => {
    // An HTTP server, which the api reaches itself, through the guarded fetch.
    await call('POST', '/api/admin/mcp-origins', { origin: UNLISTED_ORIGIN });
    httpServer = (
      await call<{ server: { id: string; name: string } }>('POST', `${ws()}/mcp-servers`, {
        transport: 'streamable_http',
        name: `plain${tag}`,
        url: UNLISTED_URL,
        authMode: 'none',
      })
    ).server;
  });

  it('NF-S4: with the sandbox stopped, stdio fails closed as unreachable, and HTTP tools still work', async () => {
    compose('stop', 'sandbox');
    try {
      expect(await testServer(stdioServer.id)).toEqual({ status: 'unreachable', tools: [] });
      expect((await testServer(httpServer.id)).status).toBe('ok');
      expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    } finally {
      compose('start', 'sandbox');
      await healthy('sandbox');
    }
    expect((await testServer(stdioServer.id)).status).toBe('ok');
  });

  it('NF-S4: with the egress proxy stopped, a stdio server has no network at all', async () => {
    compose('stop', 'egress');
    try {
      const report = await probe();
      expect(report.proxied.listed).not.toBe('200');
      expect(report.ignoringProxy).not.toBe('200');
    } finally {
      compose('start', 'egress');
      await healthy('egress');
    }
  });

  it('NF-S4, BG-5: killing the tool host mid-call fails the call, and its budget settles', async () => {
    const held = runTool('hold');
    for (let i = 0; i < 30 && slotProcesses() === 0; i += 1) await sleep(500);
    expect(slotProcesses()).toBeGreaterThan(0);
    compose('kill', 'sandbox');
    try {
      const { requestId, text } = await held;
      // The model was told the tool is unavailable, not given a result.
      expect(text).not.toContain('"held":true');
      let states: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        states = compose(
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          'lakka',
          '-d',
          'lakka',
          '-Atc',
          `select state from reservations where request_id = '${requestId}' and state <> 'denied'`,
        )
          .split('\n')
          .filter((s) => s !== '');
        if (states.length > 0 && states.every((s) => s === 'settled')) break;
        await sleep(500);
      }
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((s) => s === 'settled')).toBe(true);
    } finally {
      compose('start', 'sandbox');
      await healthy('sandbox');
    }
    expect((await testServer(stdioServer.id)).status).toBe('ok');
  });
});
