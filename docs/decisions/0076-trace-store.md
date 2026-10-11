# 0076. The trace store

Status: accepted; widened by ADR 0095 (stored span attributes).

## Context

- Requirements:
  - OB-1: a trace per request, with spans for model calls, tool calls and routing decisions;
  - OB-3: traces stored locally by default, with no external dependency;
  - OB-4: content capture off by default;
  - AC 19: every model call produces a span with the model, token counts, cost, latency and routing decision.
- ADR 0041 created the spans in M2 and left storage to M7. It also said to hand core an explicit tracer provider rather than register a global one, because Better Auth and Drizzle speak the OpenTelemetry API too.
- The spec's data model has a `spans` table partitioned by month, whose retention drops whole partitions (ADR 0075 Q1: 30 days).

## Decision

- **`createTracing({ db, logger })`** (core) gives each process its own `BasicTracerProvider`, from `@opentelemetry/sdk-trace-base` (ADR 0075 Q2).
  - The provider is not registered globally, so libraries' spans stay no-ops; a test checks this.
  - Spans are written to Postgres in batches, about once a second.
  - The api flushes them on shutdown, before its pool closes.
  - The test app uses the same tracing, so integration tests read the stored spans.
- **`spans`** is partitioned by month on `started_at`, with a migration adding `PARTITION BY` by hand as for `usage`. `ensureMonthlyPartitions` now creates this month and the next two for both tables.
  - **Columns:** trace, span and parent ids, workspace, request, name, kind, status, error type, start, duration, attributes and events.
  - **Indexes:** by workspace and time, by request, and by trace.
- **An allowlist decides what is kept.** The exporter stores only the attribute names in `STORED_ATTRIBUTES`: our `gen_ai.*` and `lakka.*` names, and `error.type`. Event attributes are filtered the same way. A name must be added there deliberately before it is stored, so content cannot reach the store through a span, whoever made it (AC 20). A workspace or request id that is not a UUID is stored as none.
- **Every span knows its request and workspace.** A span processor copies them from the parent span when a span starts, so a span started deep in the gateway is still read within its workspace (AC 16).
- **The span tree** now matches the spec:
  - **`request`,** the root. It is a server span with the surface, the principal, the acting person, the conversation, the model and the outcome. It ends when the reply has ended and been settled, or with `error.type` when the request is refused.
  - **Under it:**
    - `policy.resolve_model` and `policy.reserve_budget`;
    - `gateway.dispatch`, with a `chat <model>` span for each attempt. Both now also carry the routing decision (AC 19);
    - `execute_tool`, which was previously a trace of its own and is now a child of the request;
    - `policy.reconcile`, which is new: amounts reserved and actual, their difference, and which attempts it settled. There is one for each round of a tool loop.
- **Failures.** A failed write drops that batch and logs `tracing.export_failed` with the count. A trace is never worth failing a request for, and spend is metered in `usage`, not in spans.
- **`x-lakka-request-id` is now sent on refused requests too**, as soon as the request has an id. That way an operator can find the trace of a request the client saw refused.

## Consequences

- Every request leaves one trace in the database, with no backend to run. The trace UI reads it (ADR 0079), retention drops old partitions (ADR 0078), and OTLP export can also send spans elsewhere (ADR 0080).
- Spans for requests the pipeline never saw, such as a malformed body refused at the surface, are not written.
- Batching means a trace appears about a second after its request ends. A crash loses at most the last batch.
