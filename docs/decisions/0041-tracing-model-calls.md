# 0041. Tracing model calls

Status: accepted

## Context

- OB-1: a trace per request, with spans for model calls.
- OB-2: the OpenTelemetry GenAI semantic conventions.
- OB-3 and NF-P1: local storage by default, with nothing leaving the instance.
- OB-4: no content unless a workspace opts in.

The roadmap starts spans in M2 and leaves storage, retention, OTLP export and the UI to M7. The M2 plan's D6 records spans now and stores them in M7.

## Decision

- **Runtime dependency: `@opentelemetry/api` only** (Apache-2.0, CNCF).
  - Core gets its tracer from the global API unless one is injected. With no tracer provider registered, as in production until M7, every span is a no-op and nothing is exported anywhere.
  - The SDK and the semantic-conventions package are development dependencies, used by tests (an in-memory exporter, and a check of attribute names).
  - Of the plan's D1 packages, only the API ships.
- **Span layout:**
  - `gateway.dispatch` for each request, nested under the surface's request span when one is passed in (M5). It carries request id, workspace, surface, final model, attempts, outcome and cost, plus an event for each skipped candidate with the reason's error code.
  - Under it, one `chat <model>` client span per attempt, named as the conventions ask.
- **GenAI attributes on each chat span:**
  - operation, provider name (the conventions' value, or the endpoint name for OpenAI-compatible servers), request model, max tokens, temperature, streaming
  - finish reasons and time to first chunk
  - input tokens (cached included, as the conventions ask), output, cache-read, cache-creation and reasoning tokens
- **Our own attributes** (`lakka.*`): model reference, attempt number, outcome, cost in micro-USD, whether usage was estimated, and the provider's HTTP status on failures.
- **Failed attempts** end with `error.type` set to the failure kind (`overloaded`, `auth`, and so on). The dispatch span ends with the error code the caller received.
- **Names are kept in our code.** The GenAI conventions are experimental and have moved to their own repository, so their constants are deprecated in the package. A test pins our names to the published values.
- **Never content:** no prompt, response or tool text in attributes, events or status.
  - Status messages stay generic.
  - Exceptions are not recorded with `recordException`, because provider error text can echo the request. A test checks this, and fails if `recordException` is added.
  - Content capture, when a workspace opts in, goes to `span_content` in M7, never into span attributes.

## Consequences

- Until M7, traces exist only for tests and for anyone who registers a tracer provider in their own build. M7 adds the Postgres exporter, partitioning, retention and optional OTLP export, without touching the instrumentation.
- Attribute names may need updating when the GenAI conventions stabilize; the pinned test shows exactly where.
- Better Auth, Drizzle and Vitest list `@opentelemetry/api` as an optional peer, so with it installed they can emit spans of their own through the global API. Today those are no-ops. M7 should give core's tracer an explicit provider rather than registering a global one; otherwise it must first check that those libraries' spans carry no SQL text, emails or other data invariant 9 forbids.
