# 0017. Health endpoint semantics

Status: accepted; extended by ADR 0081 (how providers are checked).

## Context

AD-5 and NF-O4 require reachability per component. The docs do not say what status code a partial failure returns, or which dependencies are fatal.

## Decision

- `GET /healthz` returns `{status, checks: {<name>: {status, latency_ms, error_code?}}}`, validated by the `healthReport` schema in contracts.
- The status is 200 when every required dependency is ok, and 503 otherwise. Required today: database and cache.
- Each check runs concurrently under its own timeout (2 s). A failure reports `timeout` or `unreachable`, never a driver message.
- When the classifier and provider checks arrive, they are non-fatal: they report as down, but the endpoint returns 200 with an overall status of `degraded`.
- The worker exposes the same shape on an internal port (3001, not published) for its container healthcheck.

## Consequences

- A provider outage will not make compose restart the api.
- `/healthz` is reachable through Caddy without authentication. It reveals which dependencies are up, but no hostnames or messages.
