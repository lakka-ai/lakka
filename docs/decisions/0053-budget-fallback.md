# 0053. Falling back to a cheaper model when a cap has no room

Status: accepted

## Context

- BG-7: when a cap is reached, try falling back to a cheaper route before refusing, and tell the user what happened in plain language. AC 10: a request whose maximum possible output would pass the remaining budget is downgraded or refused before it is sent.
- The tech spec: re-resolve with a cost ceiling equal to the remaining headroom; if a workable model exists, re-estimate, re-reserve, proceed and attach a fallback notice; otherwise refuse with a documented, machine-readable error.
- The M4 plan (Q2) chose the candidates: the route's fallbacks, then the workspace default, the most capable one that fits. It also chose that a model the user picked themselves falls back too, with the notice.
- A refused reservation reports the least headroom left anywhere in the chain of caps (ADR 0050).

## Decision

- **When:** the first reservation is refused with `budget_exceeded`. Only then is the fallback tried; an unreachable store still refuses at once (BG-4).
- **Candidates:**
  - The route's fallbacks, then the workspace default, without duplicates or the model that was refused.
  - A candidate qualifies if it has a price and its one-attempt estimate fits the headroom the refusal reported.
  - The most capable qualifying model is tried first, measured by blended price (the same measure routing uses). If another request took the room meanwhile, the next is tried.
  - If none fits, the original `budget_exceeded` error is returned, naming the scope, and nothing is sent.
- **The same rule applies to every resolution rule.** For a model the user chose, a pinned model or the default, "the route's fallbacks" is empty, so the workspace default is the only candidate (Q2).
- **After a fallback**, the request is sent to that model alone, since the reservation was sized for it. Failing over to a model the hold does not cover could pass the cap.
- **The notice:** `ModelResponse.fallback` names the model chosen first, the model used and the scope that had no room. Surfaces turn it into plain language in M5, for example "your monthly budget is nearly used up, so this answer used a faster model".
- **The record:** usage rows keep the routing decision as it was (rule, route, confidence) and add `budget_fallback_from`, the model chosen first. Spend reports can then count downgrades (BG-8, BG-11). The span `policy.reserve_budget` carries the fallback model.
- **Conversations keep their decision.** A routed conversation remembers the model routing chose, not the one a cap forced, so the next message tries it again once there is room. Switching models for a single answer costs the provider's prompt cache once, which a hard cap justifies.
- **No output-size downgrade.** Reserving for less output than requested would change what the caller asked for without telling them. Lowering output is left to the caller, who can retry with a smaller maximum.

## Consequences

- AC 10 is met both ways: the tests cover a request downgraded to a model that fits, and one refused before anything is sent.
- A workspace with no default model and a route with no fallbacks has nothing to fall back to, and refuses.
- The plain-language notice depends on the surfaces (M5); until then, the fallback is visible on the response, in usage and in traces.
