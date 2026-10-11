import { readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

/*
 * The tools of the dependency-free MCP servers (mcp-plain-server.ts over HTTP, mcp-plain-stdio.ts
 * over stdio), and their JSON-RPC answers. Plain Node only: the acceptance stack and the tool
 * runner's container run these files without the repository's packages.
 *
 *   echo        returns its text; marked read-only
 *   delete      does nothing, but is marked destructive, so it asks first by default (H2)
 * With `whoami`, for a server behind a real authorization server (ADR 0074):
 *   whoami      names the user whose token reached it
 * With `sandbox`, for the out-of-process proof (TL-8, ADR 0073):
 *   sandbox     reports where it runs: network interfaces, whether / is writable, its uid and
 *               the cgroup limits it runs under
 *   sleep       waits the given milliseconds, for timeouts
 *   credential  says whether FIXTURE_TOKEN reached it, and its length, never its value
 *   environment the names of its environment variables, and the egress proxy it was given
 *               (NF-S4); a test proxy's token is no secret
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const BASE_TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Returns the text it is given.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'delete',
    description: 'Pretends to delete something.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true },
  },
];

const WHOAMI_TOOL = {
  name: 'whoami',
  description: 'Says whose token reached the server.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
};

const SANDBOX_TOOLS = [
  {
    name: 'sandbox',
    description: 'Reports the environment it runs in.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'sleep',
    description: 'Waits, then answers.',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'credential',
    description: 'Says whether a credential reached it.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'environment',
    description: 'Says which environment variables reached it.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

function readOr(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function rootWritable(): boolean {
  try {
    writeFileSync('/lakka-probe', 'x');
    return true;
  } catch {
    return false;
  }
}

function sandboxReport() {
  return {
    interfaces: Object.keys(networkInterfaces()).toSorted(),
    rootWritable: rootWritable(),
    uid: process.getuid?.() ?? null,
    memoryMax: readOr('/sys/fs/cgroup/memory.max'),
    pidsMax: readOr('/sys/fs/cgroup/pids.max'),
    cpuMax: readOr('/sys/fs/cgroup/cpu.max'),
  };
}

const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

export function plainTools(
  options: { sandbox?: boolean; whoami?: boolean; onCall?: (name: string) => void } = {},
) {
  const tools = [
    ...BASE_TOOLS,
    ...(options.whoami === true ? [WHOAMI_TOOL] : []),
    ...(options.sandbox === true ? SANDBOX_TOOLS : []),
  ];
  const names = new Set(tools.map((tool) => tool.name));

  async function call(
    name: string,
    args: Record<string, unknown>,
    user: string | undefined,
  ): Promise<unknown> {
    if (!names.has(name)) return { ...text(`no tool ${name}`), isError: true };
    options.onCall?.(name);
    switch (name) {
      case 'echo':
        return text(String(args['text'] ?? ''));
      case 'delete':
        return text('deleted');
      case 'whoami':
        return text(user ?? 'nobody');
      case 'sandbox':
        return text(JSON.stringify(sandboxReport()));
      case 'sleep':
        await sleep(Number(args['ms'] ?? 0));
        return text('awake');
      case 'environment':
        return text(
          JSON.stringify({
            names: Object.keys(process.env).toSorted(),
            httpsProxy: process.env['HTTPS_PROXY'] ?? null,
            nodeUseEnvProxy: process.env['NODE_USE_ENV_PROXY'] ?? null,
          }),
        );
      default: {
        const token = process.env['FIXTURE_TOKEN'];
        return text(token === undefined ? 'unset' : `set, ${token.length} characters`);
      }
    }
  }

  /** The result for a request, or undefined for a method it does not know. */
  async function answer(message: JsonRpcRequest, user: string | undefined): Promise<unknown> {
    const params = message.params ?? {};
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: params['protocolVersion'],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'lakka-plain', version: '1.0.0' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools };
      case 'tools/call':
        return call(
          String(params['name'] ?? ''),
          (params['arguments'] ?? {}) as Record<string, unknown>,
          user,
        );
      default:
        return undefined;
    }
  }

  /** A JSON-RPC response to `message`, from `user` when the server knows who is asking. */
  async function respond(message: JsonRpcRequest, user?: string): Promise<unknown> {
    const result = await answer(message, user);
    return result === undefined
      ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
      : { jsonrpc: '2.0', id: message.id, result };
  }

  return { respond };
}
