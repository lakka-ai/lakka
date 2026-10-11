import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpToolView } from '@lakka/contracts';
import type { McpTarget } from '../mcp/client.ts';
import { listAllTools, MCP_CONNECT_TIMEOUT_MS, withMcpClient } from '../mcp/client.ts';

/*
 * Where a tool actually runs (TL-8, ADR 0070). The dispatch seam hands an executor everything a
 * call needs, as plain data, so an executor in another process can take the same input: which
 * server and how to reach it, the credential, the tool, its checked arguments, and a deadline.
 * Listing a server's tools, to test or sync it, goes through the same executor, so a server is
 * only ever started where its calls run.
 *
 * The in-process executor runs here; commandExecutor (remote.ts) runs each operation in a process
 * it starts, and sandboxExecutor (sandbox.ts) in the sandbox's tool host.
 */

/** How long a tool may take (H6). */
export const TOOL_TIMEOUT_MS = 30_000;

export interface ToolExecution {
  target: McpTarget;
  secret: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
}

/** Listing a server's tools: connecting and paging through them, under one deadline. */
export interface ToolListing {
  target: McpTarget;
  secret: string | null;
  timeoutMs: number;
}

export interface ToolExecutor {
  execute(execution: ToolExecution, signal: AbortSignal): Promise<CallToolResult>;
  list(listing: ToolListing, signal: AbortSignal): Promise<McpToolView[]>;
}

export class ToolTimeoutError extends Error {
  readonly code = 'tool_timeout';
}

/** A listing with the usual deadline. */
export function toolListing(target: McpTarget, secret: string | null): ToolListing {
  return { target, secret, timeoutMs: MCP_CONNECT_TIMEOUT_MS };
}

/**
 * Runs operations in this process, each through a fresh connection to the server. A stdio
 * server started here reaches the network only through `egressProxy` when one is given: a
 * runner in the sandbox passes the proxy the api chose for the operation (NF-S4).
 */
export function inProcessExecutorWith(options: { egressProxy: string | null }): ToolExecutor {
  return {
    async execute(execution, signal) {
      const deadline = AbortSignal.timeout(execution.timeoutMs);
      const both = AbortSignal.any([signal, deadline]);
      try {
        return await withMcpClient(
          execution.target,
          execution.secret,
          async (client) =>
            (await client.callTool(
              { name: execution.toolName, arguments: execution.arguments },
              { signal: both, timeout: execution.timeoutMs },
            )) as CallToolResult,
          // Connecting counts against the same deadline.
          { timeoutMs: execution.timeoutMs, signal, egressProxy: options.egressProxy },
        );
      } catch (error) {
        if (deadline.aborted && !signal.aborted) {
          throw new ToolTimeoutError('the tool did not finish in time', { cause: error });
        }
        throw error;
      }
    },
    async list(listing, signal) {
      return withMcpClient(listing.target, listing.secret, listAllTools, {
        timeoutMs: listing.timeoutMs,
        signal,
        egressProxy: options.egressProxy,
      });
    },
  };
}

/** Runs operations in this process, with this process's network. */
export const inProcessExecutor: ToolExecutor = inProcessExecutorWith({ egressProxy: null });

/**
 * One executor for each kind of server: stdio servers run where `stdio` runs them, the sandbox in
 * production, and HTTP servers are reached from where `http` runs, the api itself (ADR 0118).
 */
export function byTransport(executors: { stdio: ToolExecutor; http: ToolExecutor }): ToolExecutor {
  const pick = (target: McpTarget) =>
    target.transport === 'stdio' ? executors.stdio : executors.http;
  return {
    execute: (execution, signal) => pick(execution.target).execute(execution, signal),
    list: (listing, signal) => pick(listing.target).list(listing, signal),
  };
}
