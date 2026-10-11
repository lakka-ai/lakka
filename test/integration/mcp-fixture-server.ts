import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/*
 * The tools every MCP test fixture offers, built with the official server package (ADR 0066 Q4):
 *   echo     returns its text; marked read-only
 *   whoami   says which credential reached it, by the caller's own description of it
 *   delete   does nothing, but is marked destructive, for approval defaults (H2)
 *
 * The 'changed' variant is the same server after an update, for syncing (ADR 0069): echo's
 * description differs, delete is gone, and report.summary is new, with a name that cannot be
 * given to a model as <server>__<tool> because of its dot.
 */

export type FixtureVariant = 'default' | 'changed';

export function fixtureServer(
  credential: () => string,
  variant: FixtureVariant = 'default',
  /** Told the name of every tool that actually runs. */
  onCall: (name: string) => void = () => undefined,
): McpServer {
  const server = new McpServer({ name: 'lakka-fixture', version: '1.0.0' });
  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description:
        variant === 'default' ? 'Returns the text it is given.' : 'Returns the text, unchanged.',
      // `options` takes anything, so a test can reach the checks after the schema.
      inputSchema: z.object({
        text: z.string(),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => {
      onCall('echo');
      return { content: [{ type: 'text', text }] };
    },
  );
  server.registerTool(
    'whoami',
    {
      description: 'Says which credential reached the server.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      onCall('whoami');
      return { content: [{ type: 'text', text: credential() }] };
    },
  );
  if (variant === 'changed') {
    server.registerTool(
      'report.summary',
      { description: 'Summarizes a report.', annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: 'text', text: 'summary' }] }),
    );
    return server;
  }
  server.registerTool(
    'delete',
    {
      description: 'Pretends to delete something.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { destructiveHint: true },
    },
    async () => {
      onCall('delete');
      return { content: [{ type: 'text', text: 'deleted' }] };
    },
  );
  return server;
}
