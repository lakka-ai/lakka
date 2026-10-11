import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

/*
 * A stdio MCP server that reports what it can and cannot do from inside the sandbox (NF-S4,
 * ADR 0118), for the stack test (test/sandbox). Plain Node, no dependencies: it is mounted into
 * the sandbox container read-only, by docker/compose.e2e.yaml. Newline-delimited JSON-RPC, as
 * the stdio transport specifies. Its command line says what to try:
 *
 *   --listed URL      an origin the instance lists, reached through the egress proxy
 *   --unlisted URL    one it does not list
 *   --internal URL    a Lakka service, listed, which the proxy must still refuse
 *   --direct H:P,...  addresses to connect to directly, ignoring the proxy
 *   --outside NAME    a name on the internet, which must not resolve in here
 *   --hold-ms N       how long `hold` holds
 *
 * Tools, all read-only and taking no arguments, as the fake provider calls them:
 *   probe     everything above, with fetch and with the http module, and the files, variables
 *             and processes it can see
 *   hold      waits, so another operation runs beside it
 *   leave     starts a process that would outlive the operation, and returns its pid
 *   exhaust   tries to start more processes, and use more memory, than its limits allow
 */

const options = new Map<string, string>();
for (let i = 2; i + 1 < process.argv.length; i += 2) {
  options.set(String(process.argv[i]).replace(/^--/, ''), String(process.argv[i + 1]));
}
const option = (name: string) => options.get(name) ?? '';

const TOOLS = ['probe', 'hold', 'leave', 'exhaust'].map((name) => ({
  name,
  description: `The sandbox probe's ${name}.`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
}));

const codeOf = (error: unknown) =>
  error instanceof Error ? String((error as { code?: unknown }).code ?? error.name) : 'unknown';

function tryRead(path: string): string {
  try {
    readFileSync(path);
    return 'read';
  } catch (error) {
    return codeOf(error);
  }
}

function tryList(path: string): string {
  try {
    readdirSync(path);
    return 'listed';
  } catch (error) {
    return codeOf(error);
  }
}

function tryWrite(path: string): string {
  try {
    writeFileSync(path, 'x');
    return 'written';
  } catch (error) {
    return codeOf(error);
  }
}

async function resolves(name: string): Promise<string> {
  try {
    return (await lookup(name)).address;
  } catch (error) {
    return codeOf(error);
  }
}

function tcp(target: string): Promise<string> {
  const at = target.lastIndexOf(':');
  return new Promise((done) => {
    const socket = connect({ host: target.slice(0, at), port: Number(target.slice(at + 1)) });
    const finish = (result: string) => {
      socket.destroy();
      done(result);
    };
    socket.setTimeout(3000, () => finish('timeout'));
    socket.once('connect', () => finish('connected'));
    socket.once('error', (error) => finish(codeOf(error)));
  });
}

async function get(url: string): Promise<string> {
  if (url === '') return 'none';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return String(res.status);
  } catch (error) {
    return codeOf((error as { cause?: unknown }).cause ?? error);
  }
}

/**
 * The same through Node's http module, which sends plain http to the proxy in absolute form, so
 * a refusal comes back as the proxy's own status rather than a failed tunnel.
 */
function getWithHttp(url: string): Promise<string> {
  if (url === '') return Promise.resolve('none');
  return new Promise((done) => {
    const req = httpGet(url, { timeout: 8000 }, (res) => {
      res.resume();
      done(String(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => done(codeOf(error)));
  });
}

/** A Node process with none of the proxy settings, trying the listed origin. */
function getIgnoringProxy(url: string): Promise<string> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) }).then((r) => console.log(r.status), (e) => console.log(String(e.cause?.code ?? e.name)))`,
      ],
      { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' } },
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', () => done(out.trim()));
  });
}

/** Every other sandbox process: whose it is, and whether its environment can be read. */
function otherProcesses() {
  const mine = process.getuid?.() ?? -1;
  const seen: { uid: number; environ: string }[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
      if (uid === mine) continue;
      seen.push({ uid, environ: tryRead(`/proc/${entry}/environ`) });
    } catch {
      // Gone between listing and reading.
    }
  }
  return seen;
}

function limit(name: string): string {
  const line = readFileSync('/proc/self/limits', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(name));
  return line?.slice(26).trim().split(/\s+/)[0] ?? 'unknown';
}

async function probe() {
  const home = process.env['HOME'] ?? '';
  return {
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    groups: process.getgroups?.() ?? [],
    env: Object.keys(process.env).toSorted(),
    files: {
      secrets: tryList('/run/lakka/secrets'),
      authSecret: tryRead('/run/lakka/secrets/auth_secret'),
      sandboxKeys: tryList('/run/lakka/sandbox'),
      toolHostToken: tryRead('/run/lakka/sandbox/tool_host_token'),
      egressKey: tryRead('/run/lakka/egress/egress_token_key'),
      toolHostSocket: tryList('/run/lakka/tool-host'),
    },
    writes: {
      home: tryWrite(join(home, 'probe')),
      tmp: tryWrite('/tmp/probe'),
      shm: tryWrite('/dev/shm/probe'),
      root: tryWrite('/probe-root'),
    },
    dns: {
      outside: await resolves(option('outside')),
      postgres: await resolves('postgres'),
      valkey: await resolves('valkey'),
      api: await resolves('api'),
      egress: await resolves('egress'),
    },
    direct: Object.fromEntries(
      await Promise.all(
        option('direct')
          .split(',')
          .filter((t) => t !== '')
          .map(async (t) => [t, await tcp(t)] as const),
      ),
    ),
    proxied: {
      listed: await get(option('listed')),
      unlisted: await get(option('unlisted')),
      internal: await get(option('internal')),
    },
    proxiedHttp: {
      listed: await getWithHttp(option('listed')),
      unlisted: await getWithHttp(option('unlisted')),
      internal: await getWithHttp(option('internal')),
    },
    ignoringProxy: await getIgnoringProxy(option('listed')),
    others: otherProcesses(),
    limits: { processes: limit('Max processes'), data: limit('Max data size') },
  };
}

function leave(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid ?? -1;
}

async function exhaust() {
  // Memory first, while a process can still be started: twice the runner's 1 GiB data limit.
  const bigAlloc = await new Promise<number | null>((done) => {
    const child = spawn(process.execPath, ['-e', 'Buffer.alloc(2 * 1024 * 1024 * 1024).fill(1)'], {
      stdio: 'ignore',
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
  const children: ChildProcess[] = [];
  let firstError = 'none';
  for (let i = 0; i < 200; i += 1) {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const started = await new Promise<boolean>((done) => {
      child.once('spawn', () => done(true));
      child.once('error', (error) => {
        firstError = codeOf(error);
        done(false);
      });
    });
    if (!started) break;
    children.push(child);
  }
  for (const child of children) child.kill('SIGKILL');
  return { bigAllocExit: bigAlloc, spawned: children.length, firstError };
}

async function call(name: string): Promise<unknown> {
  switch (name) {
    case 'probe':
      return probe();
    case 'hold':
      await sleep(Number(option('hold-ms') || 20_000));
      return { held: true };
    case 'leave':
      return { pid: leave() };
    case 'exhaust':
      return exhaust();
    default:
      return { error: `no tool ${name}` };
  }
}

interface Message {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

async function answer(message: Message): Promise<unknown> {
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: params['protocolVersion'],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lakka-sandbox-probe', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return {
        content: [{ type: 'text', text: JSON.stringify(await call(String(params['name'] ?? ''))) }],
      };
    default:
      return undefined;
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line) as Message;
  if (message.id === undefined) return;
  void answer(message).then((result) =>
    process.stdout.write(
      `${JSON.stringify(
        result === undefined
          ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
          : { jsonrpc: '2.0', id: message.id, result },
      )}\n`,
    ),
  );
});
