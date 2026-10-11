# 0079. The trace UI and usage views

Status: accepted; widened by ADR 0093 (the spend report) and by ADR 0095 (the request list).

## Context

- M7's goal: someone who didn't build the product can run it and diagnose problems. The trace store (ADR 0076) and content capture (ADR 0077) hold the data; nobody could see it yet.
- ADR 0075 H1 decided who sees traces:
  - instance admins see all;
  - workspace admins see their workspace's;
  - members see their own, linked from chat;
  - nobody sees another workspace's (AC 16).
- The spec's "metrics to have from day one" include:
  - cost per request and per principal;
  - token counts as a distribution;
  - tool error rate per tool;
  - counts of budget denials and fallbacks.
- The M4 gate carried alert delivery history forward.

## Decision

- **The request list** (`GET /api/workspaces/:id/requests`) reads the root `request` spans, newest first, 50 to a page. It pages with `before`, the start time of the oldest request shown.
  - Refused requests are listed too, with why.
  - Each row has who made it (the person, and the key if one was used), where it came from, the model, how it ended, how long it took, and what it cost, summed from `usage`.
  - A partial index on the root spans, by workspace and time, serves it.
- **One trace** (`GET /api/workspaces/:id/requests/:requestId`):
  - the spans in tree order, each with its offset from the start, duration, status, attributes and events. A span whose parent was not stored hangs from the root;
  - the model-call attempts from `usage`, with tokens, cost, latency and time to first token;
  - the captured prompts and replies, only where the workspace recorded them.
- **Who sees what** follows H1. Workspace and instance admins see every request in the workspace. Members see requests they made, directly or through their keys, and anyone else's is not found. Keys read no traces, since troubleshooting is for people.
- **Pages:**
  - `/workspaces/:id/requests`, the list, linked from the workspace page;
  - `/workspaces/:id/requests/:requestId`, the trace, with a timeline whose steps have plain names ("Choosing the model", "Holding the budget", and so on). Each step opens to its attributes.
  - Each chat reply links to its trace.
  - Spans are written about a second after a request ends, so the trace page asks again for a missing trace for a few seconds before it says the trace is not there.
  - Content, when shown, is shown as text only.
- **Usage views.** The spend report gains:
  - by surface and by route;
  - the spread of latency and of tokens, over completed attempts: the median and 95th percentile of latency, of prompt tokens (with the largest), and of reply tokens;
  - requests a cap refused outright (denied reservations);
  - tool calls by tool, with how many failed or were refused.
  - Members' reports still show only their own.
- **Alert delivery history** (`GET /api/budgets/alerts` for instance admins, `GET /api/workspaces/:id/budgets/alerts` for workspace admins): the newest alerts, each with its cap, whose cap it is, the percentage reached, what became of the delivery, how many attempts it took, and our own code for the last failure. It is shown under the webhook settings on both spend pages.

## Consequences

- An operator can go from a complaint ("my reply was slow" or "I was refused") to the request, its steps and its cost without reading logs or SQL.
- The classifier-confidence and override-rate metrics already have their own view (RT-10, the routing page) and are not repeated in the spend report.
