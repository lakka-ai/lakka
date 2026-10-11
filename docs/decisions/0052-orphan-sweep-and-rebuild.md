# 0052. The orphan sweep and the counter rebuild

Status: accepted; what its sweep charges a request with several reservations is changed by ADR 0089.

## Context

- BG-6: reservations left behind by crashed or abandoned requests are released without an operator. AC 8: killing the process mid-stream leaves no reservation held forever; it is released within the configured orphan window.
- The tech spec asks for a worker job every 30 seconds that finds reservations past their expiry, lowers their counters and marks them abandoned. It also asks that the worker regularly rebuild the Valkey counters from Postgres, and that the counters be rebuilt after Valkey restarts.
- The M4 plan chose a plain interval with an advisory lock, since pg-boss schedules are minute-granular (Q3). It also chose a sentinel key to detect a flushed Valkey (F6).
- ADR 0050 already rebuilds a missing counter from Postgres the moment a reservation needs it. ADR 0051 bounds a request to 10 minutes inside a 15-minute hold.

## Decision

- **The sweep** runs every 30 seconds. It takes up to 100 live reservations (pending or active) whose hold has lapsed, oldest first. For each:
  - it charges what the request's usage rows recorded;
  - it marks the reservation `abandoned`;
  - it then releases its holds in Valkey, where they are still present.
    Postgres is charged first, so a sweep that fails halfway never releases a hold it has not charged. A reservation already settled is skipped, so nothing is swept twice.
- **The orphan window** is the hold's lifetime (15 minutes) plus one sweep interval (30 seconds). A request settles itself well within that, because it is aborted after 10 minutes.
- **The rebuild** runs at worker start and after every tenth sweep (every five minutes).
  - It rewrites each cap's counter for the current period, and the counter of any period a live reservation still holds against, from Postgres: spend, plus the holds of pending and active reservations.
  - It keeps holds created after it read Postgres: a hold field whose reservation id (a UUIDv7) is newer than the read time is kept. The read time is moved back a minute to allow for clock differences between processes. Drift from a failed release, or from a rebuild racing a settle, therefore corrects itself within five minutes.
  - Counting pending holds is safe because holds are keyed by reservation. A pending reservation's own script then writes the same field, rather than a second one.
- **No flush sentinel.** F6 proposed a sentinel key to detect a flushed Valkey and rebuild before reserving. ADR 0050 already rebuilds each missing counter from Postgres, under the reserve path, the first time it is needed. That covers a flush, a restart and a new period with no global state. The periodic rebuild covers everything else. The sentinel would add a second path to the same result.
- **One worker at a time.** Each round holds a Postgres advisory lock taken with `pg_try_advisory_lock`. A second worker skips the round instead of waiting.
- **The worker now needs Valkey.** It opens a Valkey client, reports it in `/healthz`, and compose starts it after Valkey is healthy.

## Consequences

- AC 8 is tested directly: a child process sends a real request through the entry point, streams it, and is killed with SIGKILL. The reservation is still held afterwards, and the worker loop releases it within the hold's lifetime plus one interval.
- **A known gap:** the attempt that was streaming when the process died never recorded its usage, so what it cost is lost. The sweep can charge only what was recorded. The loss is bounded by one attempt per killed process, and the gate records it.
- Maintenance survives Postgres being down: the round fails, is logged, and changes nothing in Valkey. The next round retries.
