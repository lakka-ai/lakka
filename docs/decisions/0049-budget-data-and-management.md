# 0049. Budget data and who manages it

Status: accepted

## Context

- BG-1 needs caps at the instance, workspace, member and key levels, nested: a key's cap sits inside its owner's member cap, inside the workspace cap, inside the instance cap. BG-9 needs daily, monthly and no reset.
- The tech spec sketches `budgets` with a `spent_usd` column and a `period_started_at`, and asks that a request reserved in one period is honoured against that period even if it finishes in the next.
- Invariant 5: Postgres is the truth and Valkey only a cache that can be rebuilt from it.
- The M4 plan answered who manages what (Q1) and chose UTC periods (F1). Members see their own spend (F5).

## Decision

- **`budgets`** holds one row per capped target: scope, workspace (null for the instance), principal (the member's user principal, or the key's own principal), limit in micro-USD, period, and who last set it.
  - A unique constraint with `NULLS NOT DISTINCT` allows one cap per target, the instance included.
  - A check constraint ties each scope to the columns it needs.
  - Writes are a single `INSERT ... ON CONFLICT`, so admins setting the same cap at once cannot create two.
- **`budget_spend`** replaces the spec's single spent column. It keeps spend per budget and per period start.
  - A new period starts from zero simply by having no row yet.
  - A request charged later can name the period it reserved against.
  - Past periods stay as history.
  - A budget that never resets uses the epoch as its only period start.
- **Periods** are UTC calendar days and months (F1). `periodStart` and `periodEnd` live in `contracts`, so the api, the engine and the web compute the same bounds.
- **Who manages which cap (Q1):**
  - instance admins set the instance cap and every workspace cap. No workspace can raise its own ceiling.
  - workspace admins, and instance admins, set member and key caps inside the workspace. A member cap needs the target to be a member.
  - a key's owner may cap their own key. If an admin set the current cap, the owner may only lower it within the same period, not raise, re-period or remove it. A cap the owner set themselves they may change freely.
  - keys manage and read no budgets at all, so a leaked key cannot lift its own limit.
- **Who sees which cap (F5):** workspace and instance admins see every cap in the workspace and the instance cap above it. A member sees only their own member cap and the caps on keys they own.
- **Policy snapshot.** Limits join the per-workspace snapshot, read in the same repeatable-read transaction as the routes. A change to a workspace's caps bumps that workspace's `policy_version`; a change to the instance cap bumps every workspace's. A request therefore reserves against limits from one consistent version.
- **Money on the wire** is micro-USD as a decimal string, from `0` up to `9999999999999999` ($10 billion), matching ADR 0048.
- **Deleting a budget** deletes its spend history with it. Spend itself stays in `usage`, which is the full record.

## Consequences

- The reservation engine reads limits from the snapshot and charges spend to `budget_spend` rows keyed by the period it reserved in. The spec's "period rollover" case becomes a matter of passing the period through.
- Valkey counters can be rebuilt from `budget_spend` for current periods, plus reservations not yet settled.
- A member removed from a workspace keeps their budget row, which is harmless and returns if they rejoin.
