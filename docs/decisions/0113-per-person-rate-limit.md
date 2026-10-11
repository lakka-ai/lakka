# 0113. A per-person rate limit on model requests

Status: accepted. Extends ADR 0056: the rate limit refuses the same way when Valkey is
down.

## Context

- BG-12 (M8): limit how many model requests one person, their keys included, can start per
  minute on every surface, and refuse the rest saying how long to wait. The tech spec listed a
  rate limit as a pipeline stage from the start, but nothing enforced one: a script in a loop, or
  one person's runaway client, could start requests as fast as the providers took them, up to
  whatever the caps allowed.
- Caps bound money, not load. A person well inside their cap can still crowd out everyone else
  on the instance's provider keys, which have their own rate limits.
- Rate limits belong in Valkey (ADR 0009), and Valkey must hold nothing that cannot be rebuilt
  from Postgres (invariant 5). A key is a delegation and may never exceed its owner (invariant 2,
  ID-5).
- Budgets fail closed when Valkey is down (BG-4, invariant 3, ADR 0056). Until now, a request no
  cap applied to never touched Valkey and was served during an outage.

## Decision

- **A token bucket per person**, instance-wide, keyed by the acting person
  (`principal.actingUserId`): a key draws on its owner's bucket, and requests in different
  workspaces share it. One Lua script reads Valkey's own clock (`TIME`), refills, and takes a
  token or returns how long until one is back. It sets the key to expire once the bucket would be
  full again, so a missing key is a full bucket: a flush or restart only gives people their burst
  back, and there is nothing to rebuild. Keys are `lakka:model-rate:<person id>`.
- **One token per call to `handleModelRequest`**, on every surface, checked in core, never in a
  surface (invariant 1). A tool loop's later rounds are part of the same call and take none. An
  approval continuation is a new request and takes one.
- **Where:** in its own `policy.rate_limit` span, after authorize and the policy snapshot, and
  before the conversation, routing, the classifier and the reservation. A caller refused access
  gets their 403 or 404, not a 429, and drains nothing. A refused request holds no budget, sends
  nothing and changes no conversation.
- **The refusal** is `RateLimitedError` (`rate_limited`) with the wait in whole seconds, at least
  one. The API answers 429 `rate_limit_error` with `Retry-After`, `retry-after-ms` (which the
  official OpenAI SDKs read first) and `retry_after_seconds` under the `lakka` extension. The
  trace records the refusal as `rate_limited`, and the span carries the wait in milliseconds.
  Chat shows its designed rate limited state with the wait (CH-7).
- **Valkey unreachable: refuse**, with `budget_unavailable` (503), the error budgets use, whether
  or not a cap applies. There is no fail-open path. The project owner chose this: one rule for
  everything that depends on Valkey is easier to explain and to trust than a limit that quietly
  stops limiting during an outage, and an instance that cannot reach Valkey cannot meter capped
  requests either.
- **Settings:** `LAKKA_MODEL_REQUESTS_PER_MINUTE` (default 120; 0 turns the limit off) and
  `LAKKA_MODEL_REQUEST_BURST` (default 60), read by the api and passed on by compose. The
  burst must be at least 1: a bucket that holds nothing would refuse every request.

## Consequences

- With the limit on, which is the default, Valkey is needed for every model request, not only
  for capped ones. The tech spec's failure table says so. An operator who turns the limit off
  gets the old behaviour back for requests no cap applies to.
- A key shared by a team, such as one key behind Open WebUI, counts as its owner and gets one
  person's limit. The API and troubleshooting guides say so and suggest a dedicated person for
  such an integration.
- The limit is the same for everyone on the instance. Per-workspace or per-role limits would
  need a policy model of their own and are not built.
- The bucket uses Valkey's clock, so every api process agrees on it however their clocks drift.
