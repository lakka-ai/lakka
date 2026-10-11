import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { fixtureServer } from './mcp-fixture-server.ts';

/*
 * The fixture as a stdio server (TL-1), run as `node test/integration/mcp-stdio-server.ts`. Its
 * whoami tool reports whether FIXTURE_TOKEN arrived in its environment, and how long it is,
 * never the value.
 */

const server = fixtureServer(() => {
  const token = process.env['FIXTURE_TOKEN'];
  return token === undefined ? 'no credential' : `credential of length ${token.length}`;
});
await server.connect(new StdioServerTransport());
