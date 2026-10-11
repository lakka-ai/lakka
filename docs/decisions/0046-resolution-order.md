# 0046. The resolution order

Status: accepted

## Context

- RT-3 fixes the order that chooses a request's model. The tech spec adds "conversation already routed" as step 2: explicit, sticky, pinned, signal, classified, default.
- RT-5 needs a direction for each route (cheaper than the default or not). RT-6 sends "not sure" to the default. RT-7 keeps one decision per conversation. RT-11 turns routing off.
- The M3 plan settled the direction as a blended price (E4), a fixed list of signals (E5), and the classified text as the latest user message, if it has at least three words (E8).
- The spec does not say what routing off does to each step, what a conversation remembers, or what happens when a price or the default model is missing.

## Decision

- **One function.** `resolveRequestModel` in `core` takes the policy snapshot, the user's explicit model, the conversation's stored decision, the text, a classifier callback and a price lookup. It returns the model, its fallbacks, the rule, the route, the signal, the confidence, the reason for a default, and whether to remember the decision. The classifier callback is called only when steps 1 to 4 did not decide, and not at all when no enabled route has a centroid.
- **Routing off** skips steps 2, 4 and 5. The user's explicit choice and the workspace pin still apply, because neither is routing: one is the user's decision and the other the admin's. Step 2 is skipped too, so turning routing off takes effect in existing conversations on their next message. A conversation that was routed then loses its provider's prompt cache once, which is the admin's explicit choice.
- **Sticky** keeps the stored model even if the route has since changed its model or been deleted: switching mid-conversation throws the prompt cache away. The fallbacks come from the route's current settings if it still exists, and there are none otherwise.
- **What a conversation remembers** (RT-7): a signal decision, a classified decision, and a considered "not sure" (the classifier ran and declined). It does not remember a default reached because the message was too short, the classifier was unavailable, or no route could be scored, since nothing was judged yet and the next message may be classifiable. Explicit and pinned decisions are not remembered; they are re-evaluated on every request.
- **Direction** (E4): a route is "down" if its model's blended price, (3 x input + output) / 4 per million tokens, is below the default model's, and "up" otherwise, including at an equal price. If there is no default model or either price is unknown, the route counts as "down" and needs the higher threshold. The costly mistake to guard against is sending hard work to a weaker model.
- **Signals** (E5), matched on the same text as the classifier:
  - `code_fence`: a line starting with three backticks or tildes. Inline code does not count.
  - `code_file`: a file name ending in a source-code extension from a published list, matched in lower case only. Data and document formats (json, yaml, csv, md, txt) are left out, and so is `m`, which matches "a.m.".
  - If several signals match, the first in the published list that an enabled route claims wins. Each signal is claimed by at most one route (ADR 0042).
- **Confidence** (RT-8) is the classifier's best similarity whenever it ran, including on a "not sure" default, and null for every other rule.
- **Failover** comes only from a route: signal, classified and sticky decisions carry the route's fallbacks and cross-provider flag (E13). Explicit, pinned and default models have no fallbacks in M3.
- **No model.** If nothing chose a model and the workspace has no default, the request is refused with `NoModelError` (`no_model`, HTTP 422), rather than guessing a model.

## Consequences

- The whole order is covered by unit tests with no database or model: every rule, both thresholds, routing off, and each reason for a default.
- Step 5 stores the decision on the conversation when `remember` is true, records the rule, route and confidence on usage, and passes the model and fallbacks to `dispatch`.
- The signal list is code, not configuration. Adding a signal means a release and an update to this ADR.
