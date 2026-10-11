# 0051. Budgets in the request path

Status: accepted

## Context

- Invariant 4: reserve before dispatch, and reconcile on every exit path, including errors, aborts and client disconnects. On abort, reconcile partial usage rather than releasing the whole reservation.
- Invariant 1: every request enters core through `handleModelRequest` (ADR 0047).
- ADR 0050 gives holds a 15-minute lifetime, after which the sweep releases them. A request must therefore not outlive its hold.
- Dispatch records a usage row for every attempt that may have cost money, on every path (ADR 0040). Its `done` settles once the stream has ended, been stopped early or been aborted, and its usage is recorded.

## Decision

- **Order in `handleModelRequest`:** authorize, policy snapshot, conversation, resolve the model, _estimate and reserve_, store or clear the conversation's decision, dispatch, then settle. Reserving comes before the conversation is written, so a refused request leaves the conversation as it was.
- **What is reserved:**
  - Only when at least one cap applies (`chargeLines`). A workspace with no caps is not metered, and dispatch still refuses a model with no price.
  - The estimate covers the candidates that have a price (the chosen model and its fallbacks). A request whose models all lack a price is refused with `unknown_model` before anything is held.
  - The reservation is traced as a `policy.reserve_budget` span, carrying the number of caps, the estimate and, on refusal, the scope that refused.
- **What is settled:** the sum of the request's usage rows, which is exactly what was recorded for every attempt: completed, interrupted, aborted and abandoned ones.
  - After a stream, the returned stream's `done` settles only once the budget is settled too.
  - When dispatch fails before streaming, the budget is settled before the error is rethrown.
  - Settling never throws. If Postgres cannot be reached, the failure is logged and the reservation stays active for the sweep, which charges the same usage rows.
- **Requests have a time limit of 10 minutes**, inside the hold's 15. The limit is an abort signal joined to the caller's, so a request that runs past it ends as `aborted`, its partial usage is recorded, and it is settled before its hold could lapse. It is configurable for tests.
- **A caller that never reads the stream** never ends it, so its reservation waits for the sweep. The surfaces in M5 always read or abort their streams.
- **`ModelResponse.reservedMicroUsd`** reports what was held, or null. Surfaces can show headroom and fallback notices from it in M5.

## Consequences

- AC 7 holds through the entry point: 50 concurrent requests against a budget covering 10 send exactly 10 to the provider, and the recorded spend stays under the cap.
- AC 10 holds: a request whose maximum output would pass the remaining budget is refused before anything is sent, and the same request asking for less output goes through. The downgrade path is ADR 0053.
- A client disconnect is charged its partial usage and the rest is released. A pre-stream failure is charged what its attempts cost.
- A cap deleted without bumping the policy version would leave a stale snapshot, and reserving against it fails closed with `budget_unavailable`. The API always bumps the version in the same transaction (ADR 0049).
