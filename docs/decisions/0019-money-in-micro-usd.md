# 0019. Money is integer micro-USD

Status: accepted

## Context

The tech spec's data model uses `limit_usd`, `spent_usd`, `amount_usd`, `cost_usd` and `in_per_mtok`. `CLAUDE.md` says money is integer micro-USD stored as `bigint` in `*_micro_usd` columns, and never floats.

## Decision

`CLAUDE.md` wins. Every money column is a `bigint` named `*_micro_usd`, and computed costs round up. The tech spec's column names are read as shorthand, and the spec will be corrected when M2 adds the cost tables.

## Consequences

- Exact arithmetic in budgets and reservations. There is no float drift near a cap.
- Per-token prices below one micro-USD need care. The pricing schema is designed in M2 with that in mind.
