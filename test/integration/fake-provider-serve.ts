import { startFakeProvider } from './fake-provider.ts';
import {
  E2E_INTROSPECTION_SECRET,
  E2E_KEYCLOAK_INTERNAL_URL,
  E2E_KEYCLOAK_URL,
  KEYCLOAK_REALM,
  MCP_AUDIENCE,
  keycloakVerifier,
} from './keycloak.ts';
import { startPlainMcpServer } from './mcp-plain-server.ts';

/*
 * The fake provider as a service of its own, for the acceptance stack (docker/compose.e2e.yaml,
 * ADR 0061): chat in the browser needs a model that answers, and no test may reach a real one.
 * Beside it run MCP servers with no dependencies: one for the tool pages and approvals in chat,
 * and one that accepts only tokens from the stack's Keycloak, for per-user credentials (TL-2).
 */

const provider = await startFakeProvider({
  host: '0.0.0.0',
  port: Number(process.env['FAKE_PROVIDER_PORT'] ?? 4010),
});
process.stdout.write(`fake provider listening on ${provider.url}\n`);
const mcp = await startPlainMcpServer({
  host: '0.0.0.0',
  port: Number(process.env['FAKE_MCP_PORT'] ?? 4011),
});
process.stdout.write(`MCP server listening on ${mcp.url}\n`);
const keycloak = {
  issuer: `${E2E_KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`,
  introspection: { clientId: MCP_AUDIENCE, clientSecret: E2E_INTROSPECTION_SECRET },
};
const protectedMcp = await startPlainMcpServer(
  {
    host: '0.0.0.0',
    port: Number(process.env['FAKE_MCP_OAUTH_PORT'] ?? 4012),
    publicHost: 'fake-provider',
  },
  {
    issuer: keycloak.issuer,
    userFor: keycloakVerifier(keycloak, `${E2E_KEYCLOAK_INTERNAL_URL}/realms/${KEYCLOAK_REALM}`),
  },
);
process.stdout.write(`MCP server behind Keycloak listening on ${protectedMcp.url}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(
    signal,
    () =>
      void Promise.all([provider.close(), mcp.close(), protectedMcp.close()]).then(() =>
        process.exit(0),
      ),
  );
}
