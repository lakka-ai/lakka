import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inProcessExecutor, listAllTools, withMcpClient } from '@lakka/core';
import type { McpTarget } from '@lakka/core';
import { startPlainMcpServer } from '../../../test/integration/mcp-plain-server.ts';
import type { PlainMcpServer } from '../../../test/integration/mcp-plain-server.ts';

/*
 * The dependency-free MCP server the acceptance stack runs (docker/compose.e2e.yaml) against
 * Lakka's own client, so the browser tests of tools and approvals rest on a server the client
 * is known to speak to (TL-1).
 */

let server: PlainMcpServer;
let target: McpTarget;

beforeAll(async () => {
  server = await startPlainMcpServer();
  target = {
    transport: 'streamable_http',
    url: server.url,
    command: null,
    args: [],
    credentialEnv: null,
    allowPrivate: true,
    // The executor keeps to the allowlist the target carries (NF-S4).
    allowedOrigins: [new URL(server.url).origin],
    privateOrigins: [],
  };
});

afterAll(async () => {
  await server.close();
});

describe('the acceptance stack MCP server (TL-1)', () => {
  it('TL-1: lists its tools with their hints, and runs them through the executor', async () => {
    const tools = await withMcpClient(target, null, listAllTools);
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'delete']);
    expect(tools[0]?.annotations.readOnlyHint).toBe(true);
    expect(tools[1]?.annotations.destructiveHint).toBe(true);

    const result = await inProcessExecutor.execute(
      { target, secret: null, toolName: 'echo', arguments: { text: 'hi' }, timeoutMs: 5000 },
      new AbortController().signal,
    );
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(server.toolCalls).toEqual(['echo']);
  });
});
