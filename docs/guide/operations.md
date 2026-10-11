# Operations

Day-to-day running: health, logs, diagnostics, retention, trace export, and what happens on
restart. For sizing and first install, see [Install](install.md).

## Health

`GET /healthz` reports each component separately, so a provider outage is told apart from a
database problem. It needs no sign-in and reveals no addresses or messages:

```
curl -s http://localhost:8080/healthz
```

```json
{
  "status": "degraded",
  "checks": {
    "database": { "status": "ok", "latency_ms": 2 },
    "cache": { "status": "ok", "latency_ms": 1 },
    "classifier": { "status": "ok", "latency_ms": 0 },
    "provider:anthropic": { "status": "down", "latency_ms": 410, "error_code": "auth_failed" }
  }
}
```

| `status`   | HTTP | Meaning                                                                                                                                      |
| ---------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`       | 200  | Everything is reachable.                                                                                                                     |
| `degraded` | 200  | The database and cache are fine, but the classifier or a provider is down. Chat and the API still work; routing, or that provider, does not. |
| `down`     | 503  | The database or the cache is unreachable. Every model request is refused rather than served unmetered.                                       |

A check that is down says why:

- `timeout` or `unreachable`: no answer in time, or no connection at all;
- `auth_failed`: the provider refused the key;
- `error`: the provider answered with another error;
- `unavailable`: the classifier could not load.

`/healthz` is the api's. The `sandbox` and `egress` services, where command-line tool servers
run and reach the network, have health checks of their own; `docker compose ps` shows them. The
api does not depend on them: with either down, only command-line tool servers fail, and the
diagnostics bundle says which (`sandbox.json`).

Each instance-wide provider key is checked with a free call that lists models, at most once a
minute. Keys a workspace set for itself are not shown here; its admins see them under **Model
providers** on its **Workspace settings** page.

## Logs

```
docker compose logs -f api worker web sandbox egress
```

Logs are one JSON object per line: an event name (`api.started`, `budget.alert_delivered`,
`health.dependency_down`) and a fixed set of fields such as ids, statuses and durations. They
never contain credentials, prompts, replies or tool arguments, at any level, so they are safe to
share once you have looked at them. Set the level with `LAKKA_LOG_LEVEL` (`trace`, `debug`,
`info`, `warn`, `error`, `fatal`, or `silent`; default `info`).

The egress proxy logs each connection it refuses, as `egress.refused` with the host, port and
reason, so an origin a command-line server needs and nobody allowed shows up there. The sandbox
logs `sandbox.started` with how many slots it runs, and `sandbox.start_failed` with a reason when
it cannot start. A call that leaves something behind it cannot clean up takes its slot out of use,
logged as `sandbox.slot_quarantined`; once every slot is out of use, the sandbox stops
(`sandbox.exhausted`) and Docker starts it again, fresh.

With price updates on, the worker logs each check it makes: `catalogue_feed.applied`,
`catalogue_feed.unchanged`, or `catalogue_feed.check_failed` with the reason as `error_code`. A
bad signature, or a list older than one already applied, is logged as an error, since that is
someone's doing rather than the network's. While price updates are off, nothing is fetched and
nothing is logged.

Nothing is kept by Lakka itself: logs go to Docker, and Docker's own logging settings decide
how long they are kept.

## The diagnostics bundle

For a support request, write a diagnostics bundle and attach it:

```
docker compose exec -T api lakka diagnostics > lakka-diagnostics.tar.gz
```

Instance admins can also download it from **Diagnostics** in the menu. It holds versions, the
health of each component, whether the api reaches the sandbox and its proxy (`sandbox.json`),
settings (each secret shown only as set or not set), the recovery key versions the process was
given and which one is in use (never a key), whether price updates are on and what the last check
found, database and cache versions and sizes, counts by kind and state, background jobs, and the
last day of failed requests. It never holds credentials, prompts, replies, tool arguments, names,
email addresses, or the addresses of providers and MCP servers, and it is still written when the
database is down. Logs are not in it: send those separately if asked.

## Retention

A job in the worker deletes old records every day at 03:17 UTC. Instance admins set the periods
on the **Retention** page, where **Run now** runs it at once and the last run's counts are shown.

| Records                                                             | Kept by default                        |
| ------------------------------------------------------------------- | -------------------------------------- |
| Request traces (spans)                                              | 30 days                                |
| Recorded prompts and replies, where a workspace turned recording on | 7 days, set per workspace (1 to 90)    |
| Usage records (spend history)                                       | 13 months                              |
| Conversations                                                       | until deleted, unless you set a period |
| Tool call records                                                   | 90 days                                |
| Budget holds that are over (settled, refused or abandoned)          | 30 days                                |
| Budget alerts that were sent or given up on                         | 13 months                              |
| Unfinished tool sign-ins and expired password reset links           | removed at the next run                |

Deleting old usage never changes a budget: caps are enforced from their own running totals,
lifetime caps included. What shrinks is how far back spend reports reach. Usage is kept at least
two months, so the current and the last monthly period can always be reported.

## Sending traces to your own backend

Traces are stored in Postgres and shown in the app. To also send them to an OpenTelemetry
collector you run, over OTLP/HTTP, set:

```
LAKKA_OTLP_ENDPOINT=https://otel.example.com/v1/traces
LAKKA_OTLP_HEADERS=authorization=Bearer abc123
```

Only the same span attributes the app stores are sent: ids, models, token counts, costs,
timings and outcomes, never prompt or reply text. With the endpoint unset, nothing is sent,
whatever standard `OTEL_*` variables are set. The **Retention** page shows whether traces leave
the instance, and to where.

## Restarts and shutdown

`docker compose restart api` or a stop lets requests already in flight finish for up to 20
seconds; new ones are refused with 503 meanwhile. A stream still open after that ends with an
error event (`server_shutting_down`) and is charged only for what it used. Compose waits 30
seconds before it kills the api.

## No telemetry

Nothing leaves the instance unless you turn on that specific connection: model providers you
configure, identity providers and MCP servers you add, alert webhooks you set, the trace
endpoint above, price updates once an instance admin turns them on (see
[Administration](administration.md#price-updates)), and, with a domain set, the certificate
authority Caddy gets certificates from. There are no analytics, error reports or update checks.
