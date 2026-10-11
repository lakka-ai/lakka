# 0047. The model request entry point, conversations and overrides

Status: accepted

## Context

- Invariant 1 (API-3): every request from every surface enters `core` through one entry point that takes a normalized request and a Principal. ADR 0020 puts the pipeline in `core`; ADR 0040 made `dispatch` the gateway's entry point and kept anything user-facing away from it until budgets exist (D5).
- RT-7 keeps one routing decision per conversation. RT-8 records the rule and confidence behind every request. RT-9 records overrides against the route that lost; AC 12 tests it. AC 13: everything works with routing off.
- The tech spec's data model gives `conversations` routing fields and `usage` the columns `route_id`, `resolution_rule`, `route_confidence` and `was_overridden`. The M3 plan chose a conversations table with routing fields only (E7) and overrides with no message text until the content opt-in exists in M7 (Q2).
- ADR 0046 defines the resolution order and what a conversation remembers.

## Decision

- **`handleModelRequest(ctx, request)`** in `core` is the entry point. A `ModelRequest` carries the request id, surface, workspace, Principal, the normalized `GatewayRequest`, the model the user chose (or null), and the conversation (or null). In order, it:
  1. authorizes `models.use` in the workspace;
  2. reads the policy snapshot;
  3. loads the conversation, if one was named, scoped to the workspace and to the acting person;
  4. resolves the model (ADR 0046), tracing the decision as a `policy.resolve_model` span;
  5. clears or stores the conversation's decision;
  6. dispatches to the model and its fallbacks, with the decision recorded on every usage row.
     Budget estimation and reservation go between steps 5 and 6 (ADR 0051).
- **`models.use`** is a new workspace action for members, admins and keys in their own workspace. It needs membership even for instance admins: spend is attributed to a member (and counted against a member budget), and managing a workspace is not the same as spending its money. A non-member instance admin gets `forbidden`, as they already can see the workspace.
- **Conversations** hold routing state only: workspace, owner, route, routed model and decision time.
  - The owner is always a person. A conversation started through a key belongs to the key's owner, and the key can continue its owner's conversations (invariant 2). A schema check makes the owner a user.
  - Reads are scoped by workspace and owner, so another person's conversation, or one from another workspace, is `not_found`.
  - The routed model is stored with the route. Deleting the route sets `route_id` to null and keeps the model (ADR 0046).
  - Two first messages racing each other both resolve; only the first decision is stored.
  - `startConversation` is the only way to create one in M3. Chat adds messages and titles in M5, and M5 also decides how the API names a conversation.
- **Overrides** (RT-9): a request in a conversation with a stored decision, naming a model different from the stored one, is an override.
  - Its usage rows have `resolution_rule = 'explicit'`, `was_overridden = true`, `route_id` set to the route that lost (null if the conversation had a considered "not sure"), and `overridden_model` set to the model the conversation had. The losing model is stored so the RT-10 summary can tell whether users moved to a stronger or a cheaper model, even after the route changes.
  - The conversation's decision is cleared, so the next message without a chosen model is decided afresh.
  - Naming the model the conversation already has is not an override.
  - No message text is stored (Q2). The spec's override candidates join the M7 content opt-in.
- **Usage columns**: `resolution_rule` (required), `route_id`, `route_confidence`, `default_reason`, `was_overridden` and `overridden_model`. Check constraints keep them consistent: a default reason exactly when the rule is `default`, an overridden model exactly when overridden, and overrides only on explicit requests. Rows recorded before this migration came from callers that named their model, and are backfilled as `explicit`. Every attempt of a request carries the same decision, so reports count requests, not rows.
- **Stale centroids.** When the classifier's model differs from a route's centroid (a new embedding model), the request goes on without that route, and a rebuild of the workspace's policy starts in the background, one per workspace at a time. ADR 0043 left this open.
- **`DispatchRequest.routing`** is now required, so nothing can reach a model without saying which rule chose it.

## Consequences

- The M3 exit criterion "every request carries a recorded routing decision" holds for every request that reaches a provider, by type and by schema. A refused request records nothing in usage; one refused while resolving, for lack of a model, still shows in its `policy.resolve_model` span.
- Surfaces in M5 fill a `ModelRequest` and call one function; chat and the API cannot differ in policy.
- The RT-10 summary (ADR 0048) reads overrides from usage by route, with the losing and chosen models for direction and cost.
