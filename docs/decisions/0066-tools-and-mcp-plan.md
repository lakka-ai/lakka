# 0066. Tools and MCP: scope and decisions

Status: accepted; its Q5 is superseded in part by ADR 0074 (Keycloak as the authorization server); its H11 is superseded by ADR 0118 (stdio servers run out of process, in the sandbox).

## Context

- M6 (roadmap) delivers:
  - an MCP client over stdio and Streamable HTTP;
  - OAuth for per-user credentials;
  - workspace tool allowlists;
  - approvals, including standing approvals;
  - a dispatch layer that can run tools out of process;
  - iteration limits;
  - delimiting untrusted content;
  - a full audit of tool calls.
- Exit criteria:
  - AC 18;
  - per-user credentials shown working against a real MCP server;
  - one tool run out of process.
- The M6 plan put five questions to the user, who chose the recommendations (Q1 to Q5), and approved the smaller decisions (H1 to H11).

## Decision

- **Q1, no inbound MCP surface in v1.** The spec's topology and surfaces table show MCP clients calling Lakka. CLAUDE.md defers that "outbound MCP server" to v2, and the M6 scope lists only the client. M6 builds Lakka as an MCP client, and the spec's table now says so.
- **Q2, who configures servers:**
  - A stdio server runs a command inside the api container, so only instance admins add one. Its command must already be in the image or a mounted volume; nothing downloads at boot (invariant 12).
  - Workspace admins add Streamable HTTP servers, public https only.
  - A private address needs its origin listed in `LAKKA_MCP_PRIVATE_ORIGINS`, as identity providers need `LAKKA_OIDC_PRIVATE_ORIGINS` (ADR 0032).
- **Q3, tool arguments are audit data.**
  - TL-6 requires recording them, so `tool_invocations` stores them, capped at 16 KB.
  - They never go in logs or spans.
  - Invariant 9 names this as a place content is stored.
  - Retention arrives with the rest in M7 (NF-P5).
- **Q4, dependencies:**
  - `@modelcontextprotocol/client` 2.1.0 (MIT, the official SDK) is a runtime dependency of `core`, for the protocol, both transports and the OAuth authorization flow.
  - `@modelcontextprotocol/server` 2.1.0 is a test-only devDependency, for fixture servers.
- **Q5, the real server:** per-user OAuth is shown in CI against a real open-source server that implements the MCP authorization spec, run unmodified. A documented manual run against a public OAuth MCP server is recorded in the gate.
  - Superseded in part by ADR 0074: the SDK example's demo authorization server signs everyone in as one user, so Keycloak is the authorization server instead.
- **H1:** the model sees tools as `<server>__<tool>`, within `[a-zA-Z0-9_-]{1,64}`. Internally a tool is keyed by server id and tool name.
- **H2:** a tool its server marks `readOnlyHint` needs no approval by default; every other tool does. Annotations are the server's untrusted hints: they set defaults and never override an admin.
- **H3:** server-side tools run when a request names a conversation. Chat always does; an API caller may with the header. Without one, `/v1` stays stateless and standard.
- **H4:** client-defined OpenAI `tools` are passed to the model and returned as `tool_calls` for the client to run, lifting G6. Mixing them with server tools in one request is refused.
- **H5:** an approval ends the run with a pending approval stored in the conversation.
  - The final chunk carries `lakka.pending_approval` (id, tool, arguments).
  - The continuation is a request with `x-lakka-approve: <id>` or `x-lakka-deny: <id>`.
  - The approval is recorded against the caller, and an approval from anyone else is refused (AC 18).
  - This is the one non-standard body field, since the format has no standard way to express it.
- **H6, limits:**
  - at most 8 model-and-tool rounds per request (TL-9);
  - 3 consecutive failures per tool;
  - a repeated identical call ends the loop;
  - a 30-second timeout per tool;
  - results capped at 16 KB, with a truncation note.
- **H7:** tool results reach the model only as tool-role messages, inside delimiters that are escaped within them. A system note says results are data; it is not relied on (NF-S8).
- **H8:** every model call in a tool loop reserves and settles on its own (invariant 4), with its own usage row under one request id. A refused reservation mid-loop ends the run with the budget message and keeps what was done.
- **H9:** text from every round streams to the client. The commitment window covers the response's first byte. A later round that fails before its first chunk may still retry or fail over.
- **H10:** revoking access ends live tool loops through the existing registry (ADR 0063) and closes that person's MCP sessions.
- **H11:** the out-of-process runner is CI only. `compose.yaml` does not change, and no stateful dependency is added (invariant 11).

## Consequences

- Later ADRs build on these without reopening them, and cover what they leave open.
- Stdio servers are an instance-level decision, because they run code on the host. A workspace can reach only public servers unless the operator says otherwise.
