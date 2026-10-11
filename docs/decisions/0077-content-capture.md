# 0077. Content capture

Status: accepted

## Context

- OB-4: prompt and response capture is off by default, with a per-workspace opt-in and a visible retention setting.
- NF-P3: turning it on is an explicit admin action, and it is logged.
- AC 20: with capture off, no prompt or response text appears anywhere in the trace store.
- The spec keeps captured content in its own table, `span_content`, so a workspace that opts out writes nothing, and retention is a delete on one table.
- ADR 0075 Q1 set the default period to 7 days, set by the workspace with its opt-in (H4). Invariant 9 names `span_content`, when a workspace opted in, as one of the places content may be stored.

## Decision

- **The setting lives on the workspace:**
  - `content_capture`, off by default;
  - `content_retention_days`, from 1 to 90, 7 by default;
  - who last changed it, and when.
  - It is read into the policy snapshot, so one request sees one value. Changing it moves the policy version on, as every policy change does.
- **Who:** anyone in the workspace can read it (`GET /api/workspaces/:id/content-capture`). Only workspace and instance admins can change it (`PUT`, the new `capture.manage` action). A key never can, even an admin's own, because recording what people say is a person's decision.
- **The change is logged** as `workspace.content_capture_changed`, with the principal, the workspace, `status` on or off, and `retention_days`. It is also shown with the setting, as "Last changed by ... on ...".
- **What is recorded:** only while the setting is on, one row per model-call attempt in `span_content`, keyed by that call's trace and span, with the workspace, the request and an expiry. It holds:
  - the prompt as sent: every message, with its text, tool calls and results, and the names of the tools offered. A file is described by media type, name and size; its bytes are not copied, since the conversation keeps its files;
  - the reply as received: text, reasoning, tool calls and the finish reason.
  - Each text is cut at 256 KB, with a note of how much was left out.
- **Nothing is recorded, or even collected, when capture is off**: the gateway holds the reply's text for capture only when the request carries the setting. Spans never carry content either way (ADR 0076). A failed write is logged as `tracing.capture_failed` and does not fail the request.
- **`span_content` is not partitioned**, unlike `spans`. Each workspace has its own period, so dropping whole months cannot honour them all. Each row carries `expires_at`, and retention (ADR 0078) deletes by it, with an index on it. The table holds content only for workspaces that opted in, so those deletes stay small.
- **Seen where it matters:**
  - the workspace page shows the setting to everyone, on or off, and admins can change it there;
  - while it is on, chat says, just above where people write, that prompts and replies are recorded and for how long.

## Consequences

- AC 20 holds by construction: with capture off, the trace store is spans alone, and spans keep only allowlisted names.
- An operator debugging a quality problem can turn capture on for a workspace, for a short period, and see exactly what was sent and received. People in that workspace are told.
- The trace UI (ADR 0079) shows captured content beside the spans for the people allowed to see that trace.
