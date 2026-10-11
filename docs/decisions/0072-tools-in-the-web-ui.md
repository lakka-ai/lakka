# 0072. Tools in the web UI

Status: accepted

## Context

- Tools need a place in the browser:
  - admins manage servers, tools, the allowlist and approval flags (TL-1, TL-3, TL-4);
  - people connect their accounts and take back standing approvals (TL-2, TL-5);
  - chat shows tool calls and asks before a tool that needs approval runs (TL-4, AC 18).
- ADR 0071 left one question open: whether chat shows tool activity live, while a reply streams. That would need another non-standard field in the OpenAI format, which ADR 0066 H5 limits to `pending_approval`.
- The acceptance stack runs the fake provider in a plain Node container, without the repository's packages, so the official MCP server package is not available there.

## Decision

- **No live tool activity.** Chat streams the model's text only. When the reply ends, chat reads the stored conversation, which holds each round, the calls it made and each result (ADR 0071). The OpenAI surface stays within H5.
- **A waiting call is part of the conversation.** The conversation view carries `pendingApproval`: the approval id, the tool, its title, the arguments from the audit, and `yours`. Chat shows the request from there, not from the stream, so it survives a reload and shows on any device.
  - `yours` is false when one of the person's keys made the call. Chat then says only that key can answer it (AC 18).
  - The arguments go only to the conversation's owner, who can already read the conversation.
- **Answers.** Allow once, Always allow and Deny send the continuation request of ADR 0071, with `x-lakka-approve`, `x-lakka-approve-scope: always` or `x-lakka-deny`. Writing a new message instead moves on, as the api already does.
- **What the model and servers say is shown as text.** Tool descriptions, arguments and results are rendered as plain text; results sit in a collapsed block.
- **Pages:**
  - `/workspaces/:id/tools` for workspace admins, with servers, tools and everyone's standing approvals. Only instance admins are offered stdio servers (ADR 0066 Q2). Credentials and OAuth clients are write-only.
  - `/workspaces/:id/connections` for members, with their OAuth connections, the tools they can use and their own standing approvals. The authorization server's redirect already lands here (ADR 0068).
- **The acceptance stack's MCP server** is `test/integration/mcp-plain-server.ts`, about a hundred lines of plain Node. It answers Streamable HTTP with JSON responses and no sessions, which the transport allows. The fake-provider container serves it on port 4011. An integration test runs Lakka's client against it, so the two stay in step. ADR 0074 adds a real server with per-user OAuth; this one only has to be simple.

## Consequences

- A person sees what tools did only once the reply has finished. Live activity can be added, but it would be a second non-standard field.
- There is one source of truth for a waiting call, and chat needs no state of its own to answer it.
- The acceptance suite exercises approvals end to end in a browser, with no new image and no new dependency.
