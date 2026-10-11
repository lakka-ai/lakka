import type { ChildProcess } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  MAX_RUNNER_REPLY_BYTES,
  MAX_RUNNER_REQUEST_BYTES,
  RUNNER_START_ALLOWANCE_MS,
  runnerRequest,
  runnerRequestTimeoutMs,
} from '@lakka/core';
import type { Logger } from '@lakka/core';
import type { Slot, SlotPool } from './slots.ts';

/*
 * The tool host (NF-S4, ADR 0118), the `sandbox` service: where stdio MCP servers run. The api
 * sends it one operation per request, a runner request as the out-of-process runner reads it
 * (tools/runner.ts), and it runs a fresh `lakka tool-runner` for it in a free slot
 * (slots.ts). It passes the runner's reply back as it is: it never reads what a server said.
 *
 *   POST /operations   Authorization: Bearer <tool host token>; body: one runner request
 *     200  the runner's reply
 *     401  no token, or the wrong one
 *     400  a body that is not a runner request; 413 one that is too large
 *     503  no slot came free before the operation's deadline
 *     504  the runner did not finish by the deadline; it and everything it started are ended
 *   GET /healthz        slots in use and free; 503 once no slot is usable
 *
 * The deadline is the operation's own and the time a runner may take to start, counted from
 * arrival, as the api's executor counts it. When the api goes away first, the operation is
 * ended too. Whatever happens, the slot is cleaned before anyone else uses it.
 */

export const OPERATIONS_PATH = '/operations';

export interface ToolHostOptions {
  /** The bearer token the api presents; read for each request. */
  token: () => string | undefined;
  slots: SlotPool;
  /** The runner command, run in each slot. */
  runner: readonly [string, ...string[]];
  logger: Logger;
  /** Time for a runner to start, on top of an operation's own deadline; tests shorten it. */
  startAllowanceMs?: number;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  const header = req.headers.authorization;
  if (token === undefined || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return false;
  }
  // Digests are the same length, so the comparison takes the same time whatever was sent.
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(token));
}

/** The body, or null once it passes `limit`. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: string): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' }).end(body);
}

export interface ToolHost {
  server: Server;
  /** Operations started since the host did, for tests. */
  readonly operations: number;
  /** Ends every running operation and cleans its slot. */
  stop(): Promise<void>;
}

export function createToolHost(options: ToolHostOptions): ToolHost {
  const running = new Map<Slot, { slot: Slot; runner: ChildProcess | null }>();
  let operations = 0;

  async function operate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const arrived = Date.now();
    if (!authorized(req, options.token())) {
      req.resume();
      send(res, 401, '{"error":"unauthorized"}');
      return;
    }
    const body = await readBody(req, MAX_RUNNER_REQUEST_BYTES);
    if (body === null) {
      send(res, 413, '{"error":"too_large"}');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      parsed = undefined;
    }
    const request = runnerRequest.safeParse(parsed);
    if (!request.success) {
      send(res, 400, '{"error":"invalid_request"}');
      return;
    }
    const deadline = AbortSignal.timeout(
      Math.max(
        0,
        arrived +
          runnerRequestTimeoutMs(request.data) +
          (options.startAllowanceMs ?? RUNNER_START_ALLOWANCE_MS) -
          Date.now(),
      ),
    );
    // The api went away: its operation is ended, and its slot never taken if not yet.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    const stop = AbortSignal.any([deadline, gone.signal]);

    const slot = await options.slots.acquire(stop);
    if (slot === null) {
      // No slot in time, or none usable at all; a caller that left hears nothing.
      send(res, 503, '{"error":"busy"}');
      return;
    }
    operations += 1;
    const started = Date.now();
    const entry: { slot: Slot; runner: ChildProcess | null } = { slot, runner: null };
    running.set(slot, entry);
    let outcome = 'failed' as 'ok' | 'timeout' | 'gone' | 'too_large' | 'failed';
    try {
      const runner = options.slots.spawnRunner(slot, options.runner);
      entry.runner = runner;
      const reply = await new Promise<Buffer | null>((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (value: Buffer | null, how: typeof outcome) => {
          if (settled) return;
          settled = true;
          outcome = how;
          stop.removeEventListener('abort', onStop);
          resolve(value);
        };
        const onStop = () => finish(null, gone.signal.aborted ? 'gone' : 'timeout');
        stop.addEventListener('abort', onStop, { once: true });
        runner.on('error', () => finish(null, 'failed'));
        runner.stdout?.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RUNNER_REPLY_BYTES) finish(null, 'too_large');
          else chunks.push(chunk);
        });
        runner.on('close', (code, signal) => {
          // A runner that dies on its own, such as Node failing to start under the limits, leaves
          // no other trace: its stderr is discarded, since a server's output may hold content.
          if (!settled && code !== 0) {
            options.logger.warn('sandbox.runner_exited', {
              slot: slot.uid,
              exit_code: code,
              signal,
            });
          }
          finish(Buffer.concat(chunks), 'ok');
        });
        // Left open while the operation runs: the runner stops when it closes.
        runner.stdin?.on('error', () => undefined);
        const line = body.toString('utf8');
        runner.stdin?.write(line.endsWith('\n') ? line : `${line}\n`);
        if (stop.aborted) onStop();
      });
      if (reply !== null) send(res, 200, reply.toString('utf8'));
      else if (outcome === 'timeout') send(res, 504, '{"error":"timeout"}');
      else send(res, 502, '{"error":"runner_failed"}');
    } finally {
      entry.runner?.stdin?.destroy();
      options.logger.debug('sandbox.operation', {
        slot: slot.uid,
        status: outcome,
        duration_ms: Date.now() - started,
        latency_ms: started - arrived,
      });
      // Before the release, which may hand the slot straight to an operation that is waiting.
      running.delete(slot);
      await options.slots.release(slot, entry.runner);
    }
  }

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === OPERATIONS_PATH) {
      operate(req, res).catch((error: unknown) => {
        options.logger.error('sandbox.operation_failed', {}, error);
        send(res, 500, '{"error":"internal"}');
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      const { usable, size, free, waiting } = options.slots;
      send(
        res,
        usable > 0 ? 200 : 503,
        JSON.stringify({ status: usable > 0 ? 'ok' : 'down', slots: size, usable, free, waiting }),
      );
      return;
    }
    req.resume();
    send(res, 404, '{"error":"not_found"}');
  });

  return {
    server,
    get operations() {
      return operations;
    },
    async stop() {
      await options.slots.stopAll(running.values());
    },
  };
}
