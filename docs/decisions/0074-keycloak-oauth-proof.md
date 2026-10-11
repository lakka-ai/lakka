# 0074. Per-user OAuth against Keycloak

Status: accepted

## Context

- M6's exit criteria ask for per-user credentials (TL-2) to be shown working against a real MCP server.
- ADR 0066 Q5 chose a real, unmodified server that implements the MCP authorization spec, with two users authorizing separately and the server seeing each of them. The candidate was the official TypeScript SDK's example server with its demo authorization server.
- On checking, that candidate cannot meet the requirement:
  - its demo authorization server signs everyone in as one fixed user (`demo@example.com`);
  - it is an example in the SDK repository, not a published package.
- Keycloak documents itself as an MCP authorization server. It supports authorization server metadata (RFC 8414), dynamic client registration (RFC 7591) and issuer identification (RFC 9207). It does not read the `resource` parameter (RFC 8707).
- The user chose Keycloak, with the MCP server built on the official server package.

## Decision

- **The authorization server is Keycloak 26.7.4** (`quay.io/keycloak/keycloak`, Apache-2.0), unmodified, in tests only. `test/integration/keycloak.ts` sets it up through the admin REST API:
  - a realm with two people;
  - anonymous dynamic client registration, for redirect URIs on Lakka's hosts only;
  - an audience mapper, so every access token names the MCP server's client (`mcp-fixture`) in `aud`, standing in for the resource indicator Keycloak ignores;
  - a confidential client for the MCP server, which validates tokens by introspection (RFC 7662). Keycloak reports a token as active only to a client in its audience, which is also the right meaning.
- **The MCP servers** accept only tokens that Keycloak's introspection reports active and meant for them, and their `whoami` tool names the token's user:
  - in the integration suite, the fixture on the official server package (`mcp-http-server.ts`), whose OAuth check can now be asynchronous;
  - in the acceptance stack, the dependency-free server (`mcp-plain-server.ts`), which the fake-provider container can run. It serves protected resource metadata (RFC 9728).
- **What is proven:**
  - **Integration** (`mcp-keycloak.integration.test.ts`), with Keycloak in a container:
    - Lakka discovers Keycloak from the server's metadata and registers itself dynamically;
    - each person signs in and consents on Keycloak's own pages, and the code is exchanged with PKCE;
    - the server sees each person by name;
    - a token near expiry is refreshed at Keycloak before the call (the realm issues 30-second tokens, under Lakka's 60-second margin);
    - a declined consent leaves the person unconnected;
    - disconnecting removes the server's tools for that person only.
  - **Acceptance** (`test/e2e/oauth.spec.ts`), in a real browser: two people each connect on their connections page through Keycloak's sign-in and consent pages, and chat's `whoami` names each of them.
- **The acceptance stack's Keycloak serves HTTPS.**
  - The MCP client refuses to send OAuth credentials to a token endpoint over plain HTTP unless it is on loopback, and Lakka keeps that rule.
  - A one-shot container makes a certificate for `keycloak.localhost` with Keycloak's own `keytool`, once per stack. The api trusts it through `NODE_EXTRA_CA_CERTS`, as an organisation trusts its internal CA, and the browser context accepts it.
  - The browser and the api use the same HTTPS address: containers through a network alias, and the browser through the published port, since Chromium resolves `*.localhost` to loopback.
  - The suite's admin calls and the MCP server's introspection use Keycloak's plain HTTP port inside the network, which carries none of Lakka's credentials.
- **The acceptance stack is served at the address the suite browses** (`LAKKA_PUBLIC_URL`). Otherwise the OAuth callback returns to `localhost` while the browser's session is on `127.0.0.1`.
- **Two fixes found along the way:**
  - When the authorization server returns an error, such as a declined consent, the pending authorization is now dropped, and the person lands back on their workspace's connections page rather than the home page.
  - The home page now says what happened when it cannot tell which workspace a connection was for.

## Consequences

- TL-2 is shown against an authorization server Lakka did not write, with real people, through every step of the flow a customer's identity provider would take.
- The resource server is still ours. The protocol behaviour under test is the client's and the authorization server's, and a server only has to check tokens and say whose they are.
- The acceptance stack is larger: Keycloak takes about ten seconds to start. The manual run against a public OAuth MCP server remains for the M6 gate.
