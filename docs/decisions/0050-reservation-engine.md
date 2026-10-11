# 0050. The reservation engine and the estimate

Status: accepted

## Context

- Invariant 4: estimate `prompt_tokens * input_price + max_output_tokens * output_price` and reserve it atomically across the whole chain of caps in one Valkey Lua script. Reconcile on every exit path.
- Invariant 3 and BG-4: refuse when Postgres or Valkey cannot be reached. Invariant 5: everything in Valkey can be rebuilt from Postgres.
- The tech spec sketches the script with a running `reserved` total per key and a separate reservation key. It also asks that Valkey and Postgres be allowed to drift, and that a rebuild corrects it.
- The M4 plan settled the output limit when none is requested (F2) and reserving for failover candidates (F3). ADR 0049 keeps spend per budget and per period.

## Decision

- **The estimate** is an upper bound for one attempt:
  - Prompt tokens use the upper byte-based reading (two bytes per token). That also picks a long-context price tier whenever the real count might reach it.
  - Each prompt token is priced at the dearer of the input and cache-write prices, since a provider may write the whole prompt to its cache at a premium.
  - Output is what dispatch will request: the request's maximum, or the model's own (F2).
  - The total is rounded up once. A request reserves for its most expensive candidate (F3).
- **Counters.** Each cap has one Valkey hash per period, keyed `budget:<budget id>:<period start ms>`. It holds a `spent` field and one `r:<reservation id>` field per hold, and what is in use is spent plus the sum of the holds. The spec's single `reserved` total is replaced so that:
  - every step is safe to repeat: a retried reserve does not count its own hold, and a release removes exactly one hold;
  - a rebuild can recreate the holds of active reservations exactly;
  - a release can tell whether the counter was rebuilt after its charge was committed, because its hold is then absent and the charge is already in `spent`.
    Counters expire two days after their period ends; a counter for a cap that never resets does not expire.
- **Reserve:**
  1. Write the reservation and its lines to Postgres as `pending`.
  2. Run one Lua script that checks every cap and adds the hold to all of them or to none. A refusal names the innermost cap that refused and the least headroom left anywhere in the chain, for the budget fallback (ADR 0053).
  3. Mark the reservation `active`.
     A counter missing from Valkey (a new period, or after a flush) is rebuilt from Postgres before reserving: spend for that period, plus the holds of active reservations. The rebuild writes only if the counter is still missing, so it never overwrites live counts. Only `active` reservations are rebuilt: one still `pending` adds its own hold when its script runs.
- **Settle** charges the actual cost to each line's period and marks the reservation `settled`, in one Postgres transaction. It then removes the hold in Valkey and adds the cost to `spent`, only where the hold was still present.
  - Settling twice charges once.
  - A line whose budget was deleted meanwhile is skipped.
  - A cost above the reservation is charged in full and logged as `budget.overage`.
  - If Valkey cannot be reached at this point, Postgres still has the charge. The stale hold only makes caps stricter until the counter is next rebuilt.
- **Failing closed.** A Postgres or Valkey error while reserving refuses the request with `budget_unavailable` (503). The reservation is left `denied`, or `pending` if Postgres itself failed, and a pending one is never rebuilt into a counter. If Postgres fails after Valkey granted the hold, the hold is released and the request refused.
- **A cap reached** refuses with `budget_exceeded` (402), naming the scope. Our API returns 402; the OpenAI-compatible mapping is decided in M5 (F4).
- **Amounts** stay below 2^53, where Lua's doubles are exact. The largest cap is therefore $1 billion (`999999999999999` micro-USD), down from the $10 billion in ADR 0049. The database check is tightened to match.
- **Holds last 15 minutes** if their request never settles them. A request's duration is bounded to fit (ADR 0051), and a sweep releases expired holds (ADR 0052).
- **A request with no caps** is not held or recorded anywhere.

## Consequences

- The spec's failure-injection tests exist and pass against real Postgres and Valkey. They were committed before the engine: 50 concurrent reservations with room for 10, nested caps, single settlement, overage, a period ending mid-request, both stores unreachable, and lost counters rebuilt.
- Known races that can still cause drift, all corrected by the periodic rebuild (ADR 0052) and all making caps stricter rather than looser:
  - a settle committing between a rebuild's read and its write;
  - Valkey failing during a release.
- Reserving costs two Postgres writes per capped request. The spec kept Postgres off the hot path, but a durable record written before the hold is what makes a rebuild exact.
