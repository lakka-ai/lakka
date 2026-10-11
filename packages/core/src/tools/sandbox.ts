import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:http';
import type { ToolHostAddress } from '../config.ts';
import { McpFailureError } from '../mcp/client.ts';
import type { McpTarget } from '../mcp/client.ts';
import { egressClaimsFor, signEgressToken } from '../net/egress-token.ts';
import { ToolTimeoutError } from './executor.ts';
import type { ToolExecutor } from './executor.ts';
import { RUNNER_START_ALLOWANCE_MS } from './remote.ts';
import {
  callResultFromReply,
  MAX_RUNNER_REPLY_BYTES,
  runnerListRequestFor,
  runnerRequestFor,
  toolsFromReply,
} from './runner.ts';

/*
 * The executor for stdio servers in production (NF-S4, TL-8, ADR 0118): every operation, a call
 * or a listing, goes to the sandbox's tool host, which runs it in a fresh runner under a uid of
 * its own, on a network whose only way out is the egress proxy.
 *
 * For each operation it makes an egress token with the rule the server keeps to, the instance's
 * allowlist for a stdio server, valid for the operation's deadline and never more than 45 s, and
 * puts it in the proxy URL the runner hands the server.
 *
 * The sandbox is not required for anything else (owner decision, ADR 0118): when the tool host
 * cannot be reached, is busy past the deadline, or its keys are missing, the operation fails
 * closed as `unreachable`, which tests and syncs report and the dispatch seam tells the model is
 * temporary. It never falls back to running the server here.
 */

export interface SandboxExecutorOptions {
  /** Where the tool host listens. */
  toolHost: Exclude<ToolHostAddress, { kind: 'in-process' }>;
  /** The tool host's bearer token; undefined while its key file is missing. */
  token: () => string | undefined;
  egress: {
    /** The proxy's origin as a server in the sandbox reaches it, such as http://egress:3128. */
    proxyUrl: string;
    /** The key egress tokens are signed with; undefined while its key file is missing. */
    key: () => string | undefined;
  };
}

/** The proxy URL a server is given: the token as the password; the user name is ignored. */
function proxyUrlFor(options: SandboxExecutorOptions, target: McpTarget, lifetimeMs: number) {
  const key = options.egress.key();
  if (key === undefined) return null;
  const token = signEgressToken(
    key,
    egressClaimsFor(
      {
        allowedOrigins: target.allowedOrigins,
        privateOrigins: target.privateOrigins,
        allowPrivate: target.allowPrivate,
      },
      lifetimeMs,
    ),
  );
  return `http://t:${token}@${new URL(options.egress.proxyUrl).host}`;
}

class ToolHostUnavailable extends Error {}

/** POSTs one operation; the reply's status and body, or ToolHostUnavailable. */
function post(
  options: SandboxExecutorOptions,
  token: string,
  body: string,
  signal: AbortSignal,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        ...where(options.toolHost),
        method: 'POST',
        path: '/operations',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        // One connection per operation: when it closes early, the tool host ends the operation.
        agent: false,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RUNNER_REPLY_BYTES) {
            req.destroy();
            reject(new McpFailureError('error'));
          } else {
            chunks.push(chunk);
          }
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', (error) => {
      reject(
        signal.aborted
          ? error
          : new ToolHostUnavailable('the tool host could not be reached', { cause: error }),
      );
    });
    req.end(body);
  });
}

/** Whether the sandbox can run stdio servers, for the diagnostics bundle (AD-3). */
export interface SandboxFacts {
  /** The tool host's health: ok, down (it answered, with no usable slot), or unreachable. */
  toolHost: 'ok' | 'down' | 'unreachable' | 'in_process';
  egress: 'ok' | 'down' | 'unreachable' | 'not_used';
  /** Whether each key file is there; never what is in it. */
  keys: { toolHostToken: boolean; egressKey: boolean };
}

const HEALTH_TIMEOUT_MS = 2000;

function health(where: RequestOptions): Promise<'ok' | 'down' | 'unreachable'> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { ...where, method: 'GET', path: '/healthz', agent: false, timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200 ? 'ok' : 'down');
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve('unreachable'));
    req.end();
  });
}

const where = (address: Exclude<ToolHostAddress, { kind: 'in-process' }>): RequestOptions =>
  address.kind === 'unix'
    ? { socketPath: address.path }
    : { host: new URL(address.url).hostname, port: Number(new URL(address.url).port) };

/** Asks the tool host and the egress proxy how they are, as the api reaches each. */
export async function readSandboxFacts(
  sandbox: { toolHost: ToolHostAddress; egressProxyUrl: string },
  keys: { toolHostToken: () => string | undefined; egressKey: () => string | undefined },
): Promise<SandboxFacts> {
  const keyFacts = {
    toolHostToken: keys.toolHostToken() !== undefined,
    egressKey: keys.egressKey() !== undefined,
  };
  if (sandbox.toolHost.kind === 'in-process') {
    return { toolHost: 'in_process', egress: 'not_used', keys: keyFacts };
  }
  const proxy = new URL(sandbox.egressProxyUrl);
  const [toolHost, egress] = await Promise.all([
    health(where(sandbox.toolHost)),
    health({ host: proxy.hostname, port: Number(proxy.port || 80) }),
  ]);
  return { toolHost, egress, keys: keyFacts };
}

export function sandboxExecutor(options: SandboxExecutorOptions): ToolExecutor {
  async function operate(
    target: McpTarget,
    timeoutMs: number,
    body: (egressProxy: string) => string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const token = options.token();
    const lifetimeMs = timeoutMs + RUNNER_START_ALLOWANCE_MS;
    const proxy = proxyUrlFor(options, target, lifetimeMs);
    // Without its keys the sandbox cannot be used, and nothing else may run the server.
    if (token === undefined || proxy === null) throw new McpFailureError('unreachable');
    const deadline = AbortSignal.timeout(lifetimeMs);
    const stop = AbortSignal.any([signal, deadline]);
    let reply: { status: number; body: Buffer };
    try {
      reply = await post(options, token, body(proxy), stop);
    } catch (error) {
      if (deadline.aborted && !signal.aborted) {
        throw new ToolTimeoutError('the tool did not finish in time', { cause: error });
      }
      if (signal.aborted) throw signal.reason;
      if (error instanceof ToolHostUnavailable) throw new McpFailureError('unreachable');
      throw error;
    }
    if (reply.status === 200) return reply.body;
    if (reply.status === 504) throw new ToolTimeoutError('the tool did not finish in time');
    // Busy past the deadline, or no slot usable: temporary, as an unreachable server is.
    if (reply.status === 503) throw new McpFailureError('unreachable');
    throw new McpFailureError('error');
  }

  return {
    async execute(execution, signal) {
      const output = await operate(
        execution.target,
        execution.timeoutMs,
        (proxy) => runnerRequestFor(execution, proxy),
        signal,
      );
      const result = callResultFromReply(output);
      if (result instanceof Error) throw result;
      return result;
    },
    async list(listing, signal) {
      const output = await operate(
        listing.target,
        listing.timeoutMs,
        (proxy) => runnerListRequestFor(listing, proxy),
        signal,
      );
      const tools = toolsFromReply(output);
      if (tools instanceof Error) throw tools;
      return tools;
    },
  };
}
