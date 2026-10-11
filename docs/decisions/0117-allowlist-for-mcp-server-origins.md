# 0117. An allowlist for MCP server origins

Status: accepted. Builds the HTTP part of NF-S4; changes ADR 0067 (where a server may
point, redirects) and ADR 0073 (the runner wire is version 2). ADR 0118 builds the stdio part.

## Context

- NF-S4 asks for outbound network access from tool execution to be blocked by default and
  allowed only by an explicit allowlist. Until now only private addresses needed a listing (ADR
  0067): a workspace admin could point a server at any public origin, an instance admin's server
  could be anywhere, and an OAuth server's metadata could name any authorization server, token
  endpoint or registration endpoint, which Lakka then called.
- "Tool execution" is three things here:
  1. Lakka's own HTTP traffic to an MCP server and its authorization server. That is ours to
     limit, and this decision limits it.
  2. A stdio server, a process the api starts, with the api container's network. It is limited
     only by the sandbox that is built next in M8 (roadmap).
  3. What a remote MCP server does itself after Lakka calls it. That is outside Lakka's
     control; the allowlist decides which servers are called, not what they do.
- An instance has a handful of tool servers, changed rarely, by people who know their addresses.
- Invariant 11 allows no new store. Invariant 5 says Valkey holds only what Postgres can rebuild.

## Decision

- **The list.** `mcp_allowed_origins` in Postgres: exact origins (scheme, host, port), no paths
  and no wildcards, each with its source (`admin` or `upgrade`), who listed it and when. It is
  instance configuration, like the retention settings, so it is not scoped to a workspace. Only
  instance admins see or change it (`GET`, `POST`, `DELETE /api/admin/mcp-origins`, and the new
  Admin page Tool servers). Origins in `LAKKA_MCP_PRIVATE_ORIGINS` count as listed, and are
  changed only there. The list is capped at 1,000 origins.
- **One normaliser, one policy.** `normaliseOrigin` (core `net/egress-policy.ts`) writes an origin
  the way it is stored and compared: lowercase scheme and host, an international name in its ASCII
  form, no default port. It is the WHATWG URL origin, and config uses it too. `decideEgress` takes
  a URL and a rule (the listed origins, the operator's private origins, and whether the traffic is
  for an instance admin's server) and returns allowed, with whether the name must resolve to public
  addresses, or a reason. It does no I/O, so the egress proxy the stdio sandbox needs can call the
  same function.
- **Every request is checked.** The guarded fetch (`net/guarded-fetch.ts`) applies the policy to
  every request Lakka makes to an MCP server or its authorization server, for every server,
  an instance admin's included. It is checked again at each layer that can tell a person why:
  - saving a server, by any admin, refuses an unlisted origin with `mcp_origin_not_allowed`
    (422), whose `error.details.origin` is the origin to list;
  - testing a server says `not_allowed`, kept as its last test; syncing records it as the sync's
    failure and answers with the same 422;
  - connecting an account, and refreshing a token, refuse an unlisted authorization server with
    the same 422;
  - the dispatch seam checks the server's origin before it resolves the credential, so no token is
    refreshed for a server that is not allowed. The model gets a final message ("an administrator
    has not allowed its server"), and the audit row is `denied`, `origin_not_allowed`.
- **Read at connect time.** The list is read from Postgres whenever a connection is made, never
  cached. Removing an origin refuses the next request to it. If the list cannot be read, nothing
  connects.
- **Redirects are never followed**, for any MCP server. A redirect is returned to the client
  library, which treats it as a failure. Following one would reach an origin nobody listed. An
  HTTP connection is therefore given only its server's own origin.
- **The private-address rule of ADR 0067 still applies on top.** Listing an origin does not open
  the private network: a name is resolved to public addresses only, at connection time, unless the
  server is an instance admin's (`allow_private`) or the origin is in
  `LAKKA_MCP_PRIVATE_ORIGINS`. A DNS record changed after listing still cannot reach inside.
- **OAuth.** Every origin the server's metadata names must be listed: the authorization server,
  its issuer, and its token, registration and authorization endpoints. The authorization endpoint
  is opened by the person's browser, not by Lakka, but is held to the same rule so there is one
  rule to know and an admin sees every party a server involves.
- **Connections are pooled per fetch.** Node's shared agents reuse a connection without looking
  the name up again, so a connection made for an instance admin's server, to a private address,
  could be reused for a workspace admin's public-only server at the same host and port. Each
  guarded fetch has agents of its own.
- **The runner wire is version 2** (`tools/runner.ts`). A `ToolExecution`'s target carries
  `allowedOrigins` and `privateOrigins`, so an out-of-process runner keeps to the same list, and a
  runner may answer `not_allowed`. The api and the runner ship in one image, so a runner refuses
  version 1 rather than run a call without its list.
- **Upgrading.** The migration lists the origins of the Streamable HTTP servers that exist
  (`source = 'upgrade'`) and marks those servers `egress_grandfathered`. The first time such a
  server's OAuth metadata is discovered, the origins it names are listed with `source = 'upgrade'`
  instead of being refused, and the mark is taken off in the same transaction, so an origin an
  instance admin removes later stays removed. Changing a server's URL or its sign-in mode takes the
  mark off too. A URL whose origin the migration cannot read the way core does, such as one with a
  non-ASCII host, is not listed; its server waits for an instance admin.
- **stdio servers** are not limited by this list yet. The sandbox (M8) gives them no network but
  an egress proxy that calls `decideEgress`; until then NF-S4 stays partial.

## Consequences

- No MCP request reaches an origin an instance admin did not list, and workspace admins cannot
  widen what Lakka reaches. A workspace admin who needs a new server asks an instance admin; the
  tool server dialog says so, and offers an instance admin to list the origin from the error.
- An instance admin's server that relied on a redirect, such as `http` to `https` or a moved path,
  fails after upgrading until its URL is changed to where the redirect pointed. The upgrade guide
  says so.
- Every connection reads one small table. That is far below the cost of connecting.
- The error body of the api may now carry `details`. It is optional, and only
  `mcp_origin_not_allowed` sets it.
- Alert webhooks keep their own public-only rule and are not on this list: they are not tool
  execution.
