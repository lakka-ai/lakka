# 0056. Refusing clearly when a store is down

Status: accepted; extended by ADR 0113 (the per-person rate limit refuses the same way).

## Context

- AC 9: with Postgres unreachable, requests are refused with a clear error, and no request is served. BG-4 and invariant 3 say the same for Valkey.
- The reservation engine already refuses with `budget_unavailable` (503) when either store fails while reserving (ADR 0050). But a request through `handleModelRequest` reads Postgres earlier, to authorize the caller and load the policy snapshot. A failure there reached the api as a bare `internal_error` (500), which tells a client neither what happened nor that retrying later may work.

## Decision

- `handleModelRequest` maps a failure to reach a store, anywhere before it returns, to `BudgetUnavailableError` (`budget_unavailable`, 503, "budgets cannot be checked right now"). The original error is kept as the cause and still logged.
- The failure is recognised by walking the error's cause chain (drivers wrap connection errors) for connection codes. These are Node's `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT` and similar, and Postgres's `08xxx`, `57P01` to `57P03` and `53300`. The pool's connection messages are recognised too.
- Our own typed errors pass through unchanged. Anything else, such as a bug, stays a 500, so it is not disguised as an outage.

## Consequences

- AC 9 holds at the entry point every surface will call: the request is refused with a clear, retryable error, and nothing reaches a provider.
- Authentication happens in the surface before core is called. A Postgres failure there is the surfaces' to map in M5, with the same code.

## Update: the surfaces' own authentication

The OpenAI-compatible surface now maps a store outage during its own authentication, and while listing models, to the same `budget_unavailable` (503), through `refusedWhenStoresDown` in core, the function `handleModelRequest` uses. `surfaces.integration.test.ts` checks it with a database that cannot be reached.
