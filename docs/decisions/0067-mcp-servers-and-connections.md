# 0067. MCP servers and connections

Status: accepted; widened by ADR 0096 (server names); changed by ADR 0117 (every
origin needs listing, and no server's redirects are followed); changed by ADR 0118 (a stdio server
runs in the sandbox, not the api container).

## Context

- TL-1: connect to MCP servers over stdio and Streamable HTTP, configured in the web UI.
- The tech spec's data model has `mcp_servers` and `mcp_credentials`, the latter keyed on server and principal, because that pairing is TL-2.
- ADR 0066 settled who configures which kind of server (Q2) and the client library (Q4).
- This ADR covers servers, shared credentials and connections. Per-user OAuth is ADR 0068; the tool tables come with ADR 0069 and ADR 0070.

## Decision

- **`mcp_servers`**, one row per server in a workspace:
  - a name unique in the workspace (`[a-z0-9-]`, up to 32 characters, since the model will see `<name>__<tool>`, H1);
  - the transport, with either a URL or a command and arguments;
  - the auth mode: `none`, `shared`, or `oauth` (ADR 0068);
  - for a stdio server with a shared credential, the environment variable it receives it in;
  - `allow_private`;
  - the last test status.
  - Check constraints keep each transport's fields consistent in Postgres, not only in code.
- **`mcp_credentials`:**
  - One row per server for its shared credential, and one per person for their own (ADR 0068). Partial unique indexes enforce both.
  - `principal_id` is whose credential it is. For a shared one, that is the admin who set it, which is what tool calls will record as `credential_principal_id` (TL-6).
  - Secrets and refresh tokens are encrypted at rest with the credential master key, like provider keys, and are write-only through the API (PR-3).
- **Who may do what** (ADR 0066 Q2):
  - Workspace admins manage their workspace's servers, through the new `tools.read` and `tools.manage` actions.
  - Adding, changing, deleting, or setting the credential of a stdio server also takes an instance admin.
  - Members and keys manage and list none of them. What members may use is tool policy (ADR 0069).
- **Where a server may point:**
  - An instance admin's HTTP server, or one whose origin is listed in `LAKKA_MCP_PRIVATE_ORIGINS`, may be anywhere.
  - A workspace admin's other servers must be https and not name a private address.
  - This is decided whenever the URL is saved, by whoever saves it, and kept as `allow_private`.
  - For a server that is not `allow_private`, every connection uses a fetch that refuses private addresses: a literal-address check before connecting, and a DNS lookup filter when connecting.
  - That fetch returns redirects rather than following them. A DNS record changed after saving, or a redirect, cannot reach inside the customer's network.
- **Connections** are opened for the work at hand and closed after it, with the official client:
  - Connecting and listing tools share a 15-second limit.
  - A stdio server gets only the environment variables the SDK deems safe to inherit, plus its credential if it takes one. Its stderr is discarded, never logged, since it can carry anything (invariant 9).
  - An HTTP server gets its shared credential as a bearer token.
- **Testing a server** connects, lists its tools with their schemas and annotations, and records `ok`, `auth_failed`, `unreachable` or `error`. The error itself is never returned or logged. A shared-credential server with no credential set is `auth_failed` without connecting.
- **Tool listings are the server's word.** Names, descriptions, schemas and annotations are passed on as data, capped at 1,000 tools. What the model sees, and what annotations may change, is decided by ADR 0069 and ADR 0070.

## Consequences

- An operator decides which private-network MCP servers a workspace may reach. A workspace admin cannot reach the network behind the instance, even by editing a DNS record later.
- Opening a connection per operation is simple, and needs no connection pool to invalidate on revocation (H10). If connecting ever proves too slow for the tool loop, pooling per server and principal can come later.
- A stdio command must exist in the api container. Nothing is downloaded (invariant 12), so installing an MCP server means building it into an image, or mounting it.
