# 0054. Budget threshold alerts

Status: accepted

## Context

- BG-10 (a SHOULD): send an alert to a configurable webhook at set thresholds.
- NF-P1 and NF-P2 (invariant 8): nothing leaves the instance unless an admin explicitly enabled that connection.
- The M4 plan chose per-budget thresholds, a webhook each budget's admin sets explicitly, and pg-boss for delivery with retries (Q3). pg-boss 12.34.0 was checked before installing:
  - MIT, actively maintained, requiring Node 22.12 or later;
  - its dependencies are MIT, ISC, Apache-2.0, and MIT or CC0.
- Budget spend is charged in one Postgres transaction per settlement (ADR 0050) or sweep (ADR 0052).
- The worker runs inside the deployment's network, next to Postgres and Valkey.

## Decision

- **Thresholds** are percentages of each budget's limit: `alert_percents`, up to five, 80 and 100 by default, empty for none. They are set with the rest of the budget.
- **Crossings are recorded where spend is charged.** The transaction that charges a reservation also inserts a `budget_alerts` row for each percentage its budget's spend has reached in that period. A unique key allows one row per budget, period and percentage. Each threshold alerts once per period, and concurrent charges cannot alert twice. A cap with a limit of zero never alerts.
- **Where alerts go:**
  - a workspace's webhook, set by its admins, for caps inside the workspace, falling back to the instance webhook;
  - the instance webhook, set by instance admins, for the instance cap.
  - With neither configured, the alert is marked `no_destination` and nothing is sent anywhere (NF-P2).
- **Webhooks:**
  - Each has a signing secret, generated as `whsec_...` when it is created. The secret is shown once, in the response to the PUT (marked `no-store`), and kept only encrypted, like provider credentials. It is never logged.
  - Every delivery carries `lakka-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, plus `lakka-event` and `lakka-delivery` (the alert id), so receivers can verify the sender and ignore repeats.
  - The payload names the budget, its scope, period, workspace and member or key, the percentage, spend and limit. It contains no request content.
- **Workspace webhooks may only reach public addresses.** A workspace admin is not trusted with the worker's network position.
  - The URL must be `https`, and may not name `localhost` or a private or loopback IP.
  - At delivery, the name is resolved and the connection refused if any address is private. Node skips the resolver for a literal IP, so that is checked separately.
  - Redirects are never followed, and the response body is never read.
  - An instance admin's webhook may point anywhere, since they run the instance.
- **Delivery through pg-boss**, in the worker only:
  - It runs in its own `pgboss` schema on the worker's existing Postgres pool, so Postgres remains the only store (invariant 11).
  - Each maintenance round (ADR 0052) hands pending alerts to the queue as jobs whose id is the alert's own. Queueing an alert twice queues it once, so a round that fails halfway loses and duplicates nothing.
  - A 5xx, 408, 429 or network failure is retried with exponential backoff, from 30 seconds, up to eight times. After that, or at once for any other status or a private address, the alert is marked `failed` with the status or error code, never a response body.
  - The api never talks to pg-boss.
- **Latency:** an alert is queued within one maintenance round (30 seconds) of the charge that caused it.

## Consequences

- Admins learn that spend is approaching a cap without watching a dashboard, and no alert leaves the instance unless they configured where it goes.
- Receivers must verify the signature and treat the delivery id as idempotent: a retry after a timeout can deliver the same alert twice.
- A threshold crossed while no webhook exists is not sent later, once one is added. The spend view still shows where budgets stand.
