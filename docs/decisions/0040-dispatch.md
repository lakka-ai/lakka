# 0040. Dispatch: checks, retries, failover and usage on every path

Status: accepted

## Context

The tech spec's gateway covers:

- resolving credentials and checking capabilities before sending
- classifying errors so a retry helps rather than wastes budget
- honouring the commitment window (invariant 6, ADR 0025)
- failing over within a model family by default
- accounting for cost on every exit path, including errors, aborts and client disconnects (invariant 4)

The M2 plan settled three further points:

- D5: no user-facing path to a model before budgets exist.
- D8: attempts given up inside the window are counted, because providers offer no idempotency keys for generation.
- D9: failover crosses providers only when allowed.

## Decision

- **One entry point**, `dispatch(ctx, request)` in core. It takes an ordered list of candidate models (the chosen one, then its fallbacks) and returns a committed stream. It knows nothing about HTTP. Budget reservation (M4) will wrap it, and surfaces (M5) will call it.
- **Checks before sending.** Each candidate needs:
  - a known price, or it is refused as `unknown_model` (BG-4)
  - a credential for the workspace (PR-8)
  - an input that fits its window, by a typical estimate
  - a requested output within its limit

  A failing candidate is skipped. If none is left, the error says why the preferred one could not serve. The output limit is always sent to the provider, defaulting to the model's maximum, so a call never produces more than the estimate assumed.

- **Failover scope (D9).** Only fallbacks from the preferred model's provider are used, unless the request allows crossing providers. A provider stands for the model family here; routes (M3) will set the scope per route.
- **Classification and actions:**

  | Failure                                                                                     | Action                                                                               |
  | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
  | 429                                                                                         | Retry the same model after Retry-After. If that is over 10 s, fail over              |
  | 5xx or 529, an empty stream, a dropped connection, an error event inside an accepted stream | Retry the same model with full-jitter backoff, then fail over                        |
  | No first chunk in time (30 s, or 180 s for reasoning models)                                | Retry, then fail over                                                                |
  | Context overflow (each provider's wording), or a model the provider does not know           | Fail over at once; if nothing is left, `context_too_long`                            |
  | 401 or 403                                                                                  | Stop: `provider_auth_failed`, which an admin must fix. No failover, as the spec says |
  | Content filter                                                                              | Stop: `content_filtered`. Never retried, never failed over                           |
  | Any other 4xx                                                                               | Stop: `provider_rejected_request`                                                    |

  Each model gets two attempts. The SDK also reports a stream that broke after a 200 as an API error with status 200; only 4xx and 5xx count as the provider answering no.

- **After the first chunk** nothing is retried or failed over, per ADR 0025. A stream that goes quiet for 60 s (180 s for reasoning models) is ended as interrupted.
- **Usage on every path.** Each attempt that may have cost money gets a usage row (ADR 0039):
  - `completed`, with the provider's own usage.
  - `interrupted`, when a committed stream failed.
  - `aborted`, when the client left or the reader stopped early, and also when the client left before any first chunk.
  - `abandoned`, for a failure inside the window after the provider accepted the request (D8).

  HTTP error responses are not billed and get no row.

- **Estimates when usage is missing:**
  - Input: two bytes of UTF-8 per token, a reading above real tokenization.
  - Output: the visible text by the same reading.
  - Reasoning models: the output limit. A model that thinks without showing it may have used all of it, and nothing tells us otherwise.

  Rows built on estimates are marked.

- **D5.** Nothing user-facing calls `dispatch` in M2. The Spike B routes stay until M5, where the chat and API surfaces give real streams to test against. This supersedes ADR 0025's plan to remove them in M2.

## Consequences

- The M2 exit criteria are proven against a fake provider over real HTTP:
  - correct cost records for the OpenAI-compatible and Anthropic protocols
  - a provider killed before the first chunk is retried invisibly
  - a provider killed after it produces an error and a usage record, not a failover
- **Estimates err towards overcharging.** A client that leaves a reasoning model early is charged the output limit. Revisit once real usage shows how much hidden reasoning an aborted call typically uses.
- **The timeouts are defaults.** A route or provider setting can tune them later without changing the mechanism.
