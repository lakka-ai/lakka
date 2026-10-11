# 0078. Retention

Status: accepted; widened by ADR 0097 (the retention page).

## Context

- Requirements:
  - OB-6: a retention policy on traces and usage records, with a documented default;
  - NF-P5: periods can be set for traces, usage records and conversations, and a scheduled job enforces them;
  - AC 21: retention enforcement demonstrably deletes records older than the configured window.
- The spec partitions `spans` and `usage` by month and has a pg-boss job drop partitions past the window, rather than deleting rows.
- ADR 0075 Q1 set the default periods, as instance settings, except captured content's (ADR 0077). H4 puts them on an admin page.

## Decision

- **`retention_settings`**, one row that the migration inserts, holds the documented defaults:

  | Records                                                                           | Default            | Range                    |
  | --------------------------------------------------------------------------------- | ------------------ | ------------------------ |
  | Traces (`spans`)                                                                  | 30 days            | 1 to 365                 |
  | Usage (`usage`)                                                                   | 13 months          | 2 to 120                 |
  | Conversations, with their messages and files                                      | kept until deleted | 1 to 3650 days, when set |
  | Tool audit (`tool_invocations`), decided approvals and revoked standing approvals | 90 days            | 1 to 3650                |
  | Budget alerts that were sent or given up on                                       | 13 months          | 1 to 120                 |
  | Budget holds that are over (settled, denied, abandoned)                           | 30 days            | 1 to 365                 |
  - Captured content goes at its own `expires_at`, from its workspace's period.
  - Unfinished MCP sign-ins go when they expire.
  - The row also records who last changed the periods, and the last run's time and counts.

- **Enforcement** (`enforceRetention`, core):
  - **Spans and usage:** whole monthly partitions that end on or before the cutoff are dropped, which is instant. The rows before the cutoff in the one month it falls inside are then deleted. Postgres prunes that delete to one partition. Retention is exact, as AC 21 asks, and the bulk of it is still a drop.
  - **Everything else:** old rows are deleted. Live reservations, pending approvals and alerts not yet sent are never touched.
  - Runs take turns under an advisory lock; a run that finds another in progress does nothing.
  - The result is logged as `retention.enforced`, with the total and the duration.
- **Scheduled as a pg-boss job,** as the spec says:
  - the worker's pg-boss now starts with its scheduler on;
  - it has a `retention` queue, scheduled daily at 03:17 UTC;
  - its handler runs `enforceRetention`.
  - Instance admins can also run it at once (`POST /api/retention/run`), which is how the clean-machine run can show AC 21 without waiting a day.
- **Budgets are unaffected by deleting usage.** Budget counters are rebuilt from `budget_spend`, not from `usage` rows, so no cap moves when old usage goes, lifetime caps included. What shrinks is how far back spend reports reach. Usage is kept at least two months, so the current and last monthly periods are always reportable.
- **These deletes run across every workspace**, like the budget maintenance queries. They are instance maintenance, run by the worker or an instance admin, never on behalf of a request, so there is no workspace to scope them to.
- **Instance admins only:** `GET` and `PUT /api/retention`, and the Retention admin page. A change is logged as `retention.changed`.

## Consequences

- Nothing grows without bound except what people chose to keep, their conversations, unless an admin sets a period for those too.
- An operator sees what the last run deleted, and when, on the admin page.
- Shortening the usage period shortens spend history. The admin page says budgets are unaffected.
