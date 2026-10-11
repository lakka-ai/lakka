import { createInterface } from 'node:readline';
import { plainTools } from './mcp-plain-tools.ts';
import type { JsonRpcRequest } from './mcp-plain-tools.ts';

/*
 * A dependency-free MCP server over stdio, for the out-of-process proof (TL-8, ADR 0073): the
 * tool runner starts it inside its locked-down container, where it has no network, so stdio is
 * the only way a tool can be reached there. Newline-delimited JSON-RPC, as the stdio transport
 * specifies. It offers the sandbox tools as well (mcp-plain-tools.ts).
 */

const { respond } = plainTools({ sandbox: true });
const lines = createInterface({ input: process.stdin });

lines.on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line) as JsonRpcRequest;
  // A notification needs no answer.
  if (message.id === undefined) return;
  void respond(message).then((response) => process.stdout.write(`${JSON.stringify(response)}\n`));
});
