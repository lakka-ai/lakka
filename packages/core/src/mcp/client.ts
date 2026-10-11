import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type { Tool, Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpOriginNotAllowedError } from '@lakka/contracts';
import type { McpTestStatus, McpToolView } from '@lakka/contracts';
import { guardedFetch } from '../net/guarded-fetch.ts';
import { PrivateAddressError } from '../net/public-address.ts';

/*
 * Connections to MCP servers (TL-1, ADR 0067), through the official client (ADR 0066 Q4). A
 * connection is opened for the work at hand and closed after it. Nothing the server says is
 * trusted: names, descriptions and schemas are passed on as data, and a stdio server's stderr is
 * discarded rather than logged, since it can carry anything (invariant 9).
 */

/** How long connecting and listing may take together. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;

/** More tools than any real server offers; a server that keeps paging is cut off here. */
const MAX_TOOLS = 1000;

export interface McpTarget {
  transport: 'stdio' | 'streamable_http';
  url: string | null;
  command: string | null;
  args: string[];
  credentialEnv: string | null;
  /** False: every connection is checked against private addresses (ADR 0066 Q2). */
  allowPrivate: boolean;
  /**
   * The origins this connection may reach (NF-S4, ADR 0117), resolved when it is made
   * (mcp/egress.ts): for an HTTP server, its own origin if it is listed, since redirects are
   * never followed; for a stdio server, the instance's whole list.
   */
  allowedOrigins: string[];
  /** The origins the operator listed as private (LAKKA_MCP_PRIVATE_ORIGINS). */
  privateOrigins: string[];
}

/**
 * What a stdio server is told about the egress proxy (NF-S4): the proxy URL, its token included,
 * in the variables most HTTP clients read, and NODE_USE_ENV_PROXY, which makes Node's own fetch
 * and http modules use them (Node 24). A process that ignores them has no network at all in the
 * sandbox, which has no route out but the proxy.
 */
export function egressProxyEnv(proxyUrl: string): Record<string, string> {
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NODE_USE_ENV_PROXY: '1',
  };
}

function transportFor(
  target: McpTarget,
  secret: string | null,
  egressProxy: string | null,
): Transport {
  if (target.transport === 'stdio') {
    // The schema guarantees a stdio server has a command.
    const command = target.command as string;
    const tmpdir = process.env['TMPDIR'];
    return new StdioClientTransport({
      command,
      args: target.args,
      // Only the variables deemed safe to inherit, the temporary directory the sandbox gives each
      // operation, and the credential if the server takes one. The proxy comes last, so no
      // credential variable can point the server elsewhere.
      env: {
        ...getDefaultEnvironment(),
        ...(tmpdir === undefined || tmpdir === '' ? {} : { TMPDIR: tmpdir }),
        ...(secret !== null && target.credentialEnv !== null
          ? { [target.credentialEnv]: secret }
          : {}),
        ...(egressProxy === null ? {} : egressProxyEnv(egressProxy)),
      },
      stderr: 'ignore',
    });
  }
  // The schema guarantees an HTTP server has a URL.
  return new StreamableHTTPClientTransport(new URL(target.url as string), {
    ...(secret === null ? {} : { authProvider: { token: async () => secret } }),
    // Always the guarded fetch, whoever added the server: only listed origins, no redirects.
    fetch: guardedFetch(target),
  });
}

export interface McpConnectionOptions {
  /** How long connecting and the work may take together. */
  timeoutMs?: number;
  /** Ends the connection early, as when the request it serves has gone. */
  signal?: AbortSignal;
  /** The egress proxy, token included, a stdio server must use (NF-S4); none in the api. */
  egressProxy?: string | null;
}

/** Connects, runs `work`, and always closes the connection. */
export async function withMcpClient<T>(
  target: McpTarget,
  secret: string | null,
  work: (client: Client, signal: AbortSignal) => Promise<T>,
  options: McpConnectionOptions = {},
): Promise<T> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  const client = new Client({ name: 'lakka', version: '1' });
  try {
    await client.connect(transportFor(target, secret, options.egressProxy ?? null), { signal });
    return await work(client, signal);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const hint = (value: unknown) => (typeof value === 'boolean' ? value : null);

function toolView(tool: Tool): McpToolView {
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    annotations: {
      readOnlyHint: hint(tool.annotations?.readOnlyHint),
      destructiveHint: hint(tool.annotations?.destructiveHint),
      idempotentHint: hint(tool.annotations?.idempotentHint),
      openWorldHint: hint(tool.annotations?.openWorldHint),
    },
  };
}

/** Every tool the server lists, following its pages. */
export async function listAllTools(client: Client, signal: AbortSignal): Promise<McpToolView[]> {
  const tools: McpToolView[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal });
    tools.push(...page.tools.map(toolView));
    cursor = page.nextCursor;
  } while (cursor !== undefined && tools.length < MAX_TOOLS);
  return tools.slice(0, MAX_TOOLS);
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ENOENT',
  'EACCES',
  'private_address',
  // A listing that ran out of time in another process (ToolTimeoutError).
  'tool_timeout',
]);

/**
 * A failure already classified somewhere else: by the tool runner in another process, which
 * sends back only the class (TL-8, ADR 0073).
 */
export class McpFailureError extends Error {
  readonly failure: Exclude<McpTestStatus, 'ok'>;

  constructor(failure: Exclude<McpTestStatus, 'ok'>) {
    super(`the tool call failed (${failure})`);
    this.name = 'McpFailureError';
    this.failure = failure;
  }
}

/** What a failed connection means for whoever set the server up, without its details. */
export function classifyMcpFailure(error: unknown): Exclude<McpTestStatus, 'ok'> {
  if (error instanceof McpFailureError) return error.failure;
  if (error instanceof UnauthorizedError) return 'auth_failed';
  if (error instanceof SdkHttpError && (error.status === 401 || error.status === 403)) {
    return 'auth_failed';
  }
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (current instanceof McpOriginNotAllowedError) return 'not_allowed';
    if (current instanceof PrivateAddressError) return 'unreachable';
    if (current.name === 'TimeoutError' || current.name === 'AbortError') return 'unreachable';
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return 'unreachable';
    current = current.cause;
  }
  return 'error';
}
