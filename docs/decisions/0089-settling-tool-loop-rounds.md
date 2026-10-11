# 0089. Settling every tool-loop round, and sweeping requests with several reservations

Status: accepted

## Context

- Invariant 4 says a reservation is reconciled on every exit path, including errors, aborts and client disconnects. ADR 0071 (H8) gives every round of a tool loop its own reservation under the request's one id, each settled with only its own attempts.
- The tool loop settled a round only after reading its stream to the end. A round that broke, was aborted, was ended by a revocation, or whose reader stopped kept its hold until the sweep released it, up to 15 minutes later. No test covered these paths.
- A dispatched stream records its usage, and settles its `done`, only when it is read to an end or closed. A continuation replays events before round one is read. A reader that stopped during them left round one unopened, so waiting on its `done` would never finish.
- The sweep (ADR 0052) charged a lapsed reservation with the sum of all its request's usage rows. That is right for a request with one reservation. For a tool loop, it also charged a later round for the earlier rounds, which had already been settled, so spend was counted twice. That can still happen when a process dies during a later round, which no in-process fix can prevent.

## Decision

- **The loop settles the round in hand on every exit.** It tracks whether the current round's stream was opened and whether its reservation was settled. In its `finally` block, an unsettled round is ended first, then settled with its own attempts, before the loop's `done` settles.
  - A round never opened is opened and closed, which ends the provider's stream and records the attempt as aborted.
  - A round that fails to start settles its own hold, as before.
- **The partial reply of a round that ended early is stored with how it ended** (`interrupted` or `aborted`), as a reply without tools already was. It is stored the same way when the reader stopped, not only when the stream failed.
- **The sweep charges a lapsed reservation with the request's usage less what the request's other settled and abandoned reservations already charged**, and never less than zero. This is exact without a schema change: the partial unique index `reservations_request_live_key` allows only one live reservation per request, so a tool loop's rounds hold one after another, never at once.
- Rejected: recording each reservation's attempt range, or a reservation id on each usage row. Either needs a migration, and the second touches the partitioned `usage` table and the dispatch record path. Both would be needed only if a request could hold two reservations at the same time, which the index forbids.

## Consequences

- A tool loop that breaks, is aborted or loses its client releases its hold within the request, like a reply without tools. It is tested in `packages/core/test/tool-loop-settlement.test.ts` and in `apps/api/test/tool-loop.integration.test.ts`.
- A later round lapsed by a killed process is charged only its own attempts, tested in `apps/api/test/budget-maintenance.integration.test.ts`.
- If a request could ever hold more than one live reservation, the sweep's subtraction would be wrong. Any change to `reservations_request_live_key` must revisit this ADR.
