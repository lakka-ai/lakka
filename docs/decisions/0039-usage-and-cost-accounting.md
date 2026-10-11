# 0039. Usage records and cost accounting

Status: accepted

## Context

BG-8 attributes every unit of spend to a principal, a workspace, a model and a routing decision. The tech spec prices a call from the provider's reported tokens at the price that applied, with cached tokens counted separately, and sketches a `usage` table partitioned by month. The M2 plan settled three questions:

- D3: copy the price into each usage row.
- D7: partition by month now, with partitions created ahead of time.
- D8: count the cost of attempts that are given up inside the commitment window.

## Decision

- **Cost arithmetic.** Each token class is multiplied by its price in micro-USD per million tokens: uncached input, cache reads, cache writes and output (reasoning included). The products are summed and divided by a million once, rounding up. All of this uses BigInt. The spec's formula has no cache-write term; Anthropic charges for cache writes and the SDK reports them, so they are priced.
- **Long-context tiers** apply to the whole call when its total input, cached tokens included, exceeds the tier's threshold. This matches how Anthropic, Google and OpenAI bill (ADR 0037).
- **Incomplete reports are billed pessimistically**, because a budget that undercounts can be exceeded (invariant 3):
  - A missing cache price bills those tokens at the input price.
  - Input the provider counted but did not split is billed as uncached. When the total and its parts disagree, the larger reading wins.
  - A count the provider did not report at all is taken from the caller's pessimistic estimate, and the row is marked `usage_estimated`. Dispatch supplies the estimate.
- **One row per provider attempt that may have cost money.** Each row records its outcome:
  - `completed`: finished with usage.
  - `interrupted`: failed after the first chunk reached the client.
  - `aborted`: the client left or the server shut down.
  - `abandoned`: given up inside the commitment window and retried or failed over. The provider may still bill its prompt (D8).

  HTTP errors that providers do not bill produce no row.

- **What a row holds:**
  - the request, attempt, surface and workspace
  - the principal (a person or key) and the acting user whose budget applies (invariant 2)
  - the model reference and provider, plus the credential used
  - every token class
  - the four prices actually applied, and the tier that applied
  - the cost, finish reason, latency and time to first token

  Routing columns (rule, confidence, override) arrive with M3.

- **No foreign keys on `usage`.** Spend history must outlive deleted credentials, keys and workspaces, and the table is written on every request.
- **Monthly partitions:**
  - `usage` is partitioned by range on `created_at`, with UTC month bounds. The migration adds `PARTITION BY` by hand, because drizzle-kit cannot express it; the generated snapshot still matches the schema, so the drift check stays meaningful.
  - `ensureUsagePartitions` creates the current month and the next two, under an advisory lock so the api and worker can run it at once. It runs at api and worker startup (not in verify-only commands), and daily in the worker.
  - There is no default partition. A missing partition makes the insert fail loudly, rather than parking rows where retention and partition creation would trip over them. With two months created ahead and a daily check, that failure needs the worker to have been down for about two months.
- **Reads are scoped by workspace**, like all tenant data.

## Consequences

- Past spend never changes when the catalogue does, and every row shows the prices it was charged at.
- The recorded cost can be above what the provider bills: rounding up once per attempt, estimates when usage is missing, and abandoned attempts. It is never below, except for prices ADR 0037 lists as not modelled.
- Retention (M7) drops whole partitions. The budget engine (M4) reconciles reservations against these costs.
