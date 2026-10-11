# 0068. Per-user credentials for MCP servers

Status: accepted

## Context

- TL-2: support per-user credentials for MCP servers through OAuth where the server offers it, so the server sees the end user and not a shared service account.
- The MCP authorization spec builds on OAuth 2.1:
  - protected resource metadata (RFC 9728);
  - authorization server metadata (RFC 8414);
  - PKCE;
  - resource indicators (RFC 8707);
  - dynamic client registration (RFC 7591) where the authorization server offers it.
- The official client provides these pieces; ADR 0066 Q4 adopted it.
- ADR 0067 stored credentials per server and person, with the shared-credential case.

## Decision

- **A person starts the connection from Lakka** (`POST /api/workspaces/:id/mcp-connections/:serverId`), from a signed-in session; keys cannot, since authorizing is a person's act. The api then:
  - discovers the authorization server from the MCP server;
  - finds the client it is registered as (below);
  - creates a random `state` and a PKCE verifier;
  - builds the authorization URL, with the MCP server as the `resource` and the scopes to ask for.
- **What is kept while the person authorizes:** a hash of the state, with the encrypted verifier, the server and the person, in `mcp_oauth_states`. It is single use (taken with `DELETE ... RETURNING`), lives ten minutes, and expired rows are cleared as new ones are written.
- **The callback** (`GET /api/mcp/oauth/callback`, the only redirect URI) is a navigation from the authorization server, so every outcome is a redirect to a page that explains it.
  - The state must belong to the same signed-in person who started. Someone else's, a replayed one, an expired one, or a callback with no session is refused, and spends the state.
  - The code is exchanged with the verifier and the resource.
  - The tokens are stored in `mcp_credentials`, encrypted, with their expiry.
  - The person lands on `/workspaces/:id/connections`; its page is in ADR 0072.
- **Client registration:**
  - If the authorization server offers dynamic registration, Lakka registers once per server, as a confidential client with the callback as its redirect URI. The result is kept, encrypted, on the server, and reused by everyone.
  - It registers again if the instance's public URL changes, or if the server's URL does.
  - Otherwise an admin enters a client id and secret registered out of band (`PUT .../oauth-client`, write-only), and connecting before then says so (`mcp_oauth_client_required`).
  - Client ID metadata documents are not used: they need a client document at a public https URL, which many self-hosted instances do not have.
- **Scopes:** the admin may set the scopes to ask for. Otherwise Lakka uses the ones the server's resource metadata advertises.
- **The resource:** the token is always for the MCP server itself. Resource metadata naming a different origin is refused.
- **Refresh:**
  - A token within a minute of expiry is refreshed before use, holding a row lock, so concurrent requests never spend the same refresh token. The second request sees what the first stored.
  - A refused refresh, or an expired token with no refresh token, deletes the credential, and the person connects again.
- **Using the credential** (`resolveMcpCredential`, what tool calls use, ADR 0070):
  - no credential for `none`;
  - the shared one, recorded as its admin's, for `shared`;
  - the acting person's own for `oauth`, so a key uses its owner's (invariant 2).
- **Network rules follow the server** (ADR 0066 Q2). For a server that must be public:
  - discovery, registration, token and refresh requests use the public-only fetch;
  - the authorization server and its endpoints must be https.
  - The person's browser, not the api, visits the authorization URL.
- **When tokens are forgotten:**
  - when the person disconnects;
  - when the server's URL changes, or it leaves OAuth;
  - when an admin enters or removes the client, since the old client's tokens may not refresh under the new one;
  - when the person leaves the workspace.
- **An admin's test of an OAuth server** uses the admin's own connection, as anyone else would use the server.

## Consequences

- An MCP server offering OAuth sees each person as themselves, and its own access rules apply to them (TL-2, NF-S2).
- A server whose authorization server does not register clients needs an admin to register Lakka once, out of band.
- Tokens are held for as long as the authorization server allows, and deleted as above. Revoking them at the authorization server on disconnect is not attempted: revocation endpoints are optional and inconsistent. The person can revoke there too.
