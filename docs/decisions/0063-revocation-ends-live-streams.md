# 0063. Revocation ends live streams

Status: accepted

## Context

- AC 6: revoking a member's access ends their chat sessions and invalidates their keys within 5 seconds. ADR 0031 met this for new requests: every request re-reads the session, key and membership, and suspension deletes sessions. What remained was streams already running, which can last up to 10 minutes (ADR 0051).
- G7 (ADR 0057) chose to subscribe to the revocation events that suspension, key revocation and membership removal already publish on Valkey.
- Those events are best effort (ADR 0031). A lost event must not let a stream run on.
- AC 4 and AC 5, and the M5 exit criterion, ask that a chat request and an API request be indistinguishable below the transport. No test yet compared the two directly.

## Decision

- **Live requests are tracked in core.** `handleModelRequest` registers each request, once it is reserved, with its principal, acting person and workspace. It registers every surface's requests the same way (invariant 1), and removes the request when it ends. Revoking a request aborts it through the same signal as a client disconnect, so the budget is settled with its partial usage (invariant 4) and a conversation keeps what arrived.
- **Two ways a request is ended:**
  - **An event** on `lakka:events:principal-revoked`, checked with zod, ends matching requests at once. A suspension names a person and ends everything they do, their keys included. A key's revocation ends that key's requests only. A removal ends the person's requests, and their keys' requests, in that workspace only.
  - **A check against Postgres every 2 seconds**, while any request is live, ends those that authentication would now refuse: the acting person is not active, is no longer a member, or the key is revoked. This covers a lost event, so the 5 seconds hold without Valkey pub/sub. It is one pair of queries per round, and none when nothing is streaming. If Postgres is unreachable, the check logs a warning and ends nothing, since streams already hold their reservations.
- **Where it runs:** in the API process, which holds the streams. `buildServer` owns the registry and starts the watcher when the server is ready and stops it on close. A subscription that cannot be made is logged, not fatal.
- **What the caller sees:** a typed `AccessRevokedError` (`access_revoked`, 403).
  - A stream that has started ends with an OpenAI-shaped error event of type `permission_error` and code `access_revoked`.
  - A request not yet streaming gets it as a JSON error.
  - Chat says the person's access to the workspace has ended and that what arrived is kept.
  - Each ended request is logged as `request.revoked`, with the request, principal, workspace and which store reported it (`valkey` or `postgres`), and no content.
- **`not_found` keeps its own code on `/v1`.** Until now, every `NotFoundError` became `model_not_found`, so a person removed from a workspace was told their model was unavailable. An unknown or disabled route now raises `UnknownModelError`, which remains `model_not_found`. A missing workspace or conversation is `not_found`, and chat says the workspace or conversation is no longer available to them.
- **Cross-surface tests** (`surfaces.integration.test.ts`) call `/v1` as chat does (a session) and as the API does (the same person's key), and compare them:
  - AC 4, in both orders: with $0.50 left, the first request holds the budget and the second is downgraded to the workspace default, both charged to the same member cap;
  - AC 5: the same code picks the code route and records the same rule and route;
  - AC 6: removal, suspension and key revocation end the right streams and no others within 5 seconds, including with events turned off.

## Consequences

- A revoked person's stream stops within 5 seconds whether or not the event arrives. In practice it is well under a second.
- While streams are open, the API queries Postgres every 2 seconds, which is negligible at the target size.
- A revocation that happens between authorization and registration is caught by the next check, still within 5 seconds.
- Only the process holding a stream can end it. That fits the single-instance deployment; multi-instance is out of scope for v1.
