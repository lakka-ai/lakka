# 0005. Logging library and structural log redaction

Status: accepted

## Context

Invariant 9 and NF-S5 forbid credentials, prompts, responses and tool arguments in logs at any level. Convention alone does not hold: pino's standard `err` serializer copies every enumerable property, and the AI SDK's `APICallError` carries the full prompt in `requestBodyValues`. Fastify's default request log includes the raw URL with its query string.

## Decision

- pino 10 through a wrapper in `packages/core/src/logger.ts`. Callers log an event name and typed fields; only names in `LOG_FIELDS` with primitive values are accepted.
- The same filter runs inside pino (`hooks.logMethod`, `formatters.bindings`, and an override of `child()`), so Fastify and any other holder of the raw instance are filtered too.
- Messages must look like event names (`health.dependency_down`). Anything else becomes `log.message_rejected`, and interpolation arguments are discarded.
- Errors keep their name, a safe code and stack frames only. The message is kept only for our own `LakkaError` classes.
- Fastify's request logging is disabled. The api logs one `http.request` line per request, with the route pattern, not the URL.
- Caddy's access log is off.
- oxlint bans `console` everywhere, and bans importing `pino` outside the logger module.
- Canary tests send a marker value through headers, cookies, query strings, bodies and error messages, and fail if it reaches the log output.
- GLIDE's native logger is turned off, because it writes to the console directly.

## Consequences

- Adding a log field means adding its name to `LOG_FIELDS`, which gets reviewed.
- Third-party error messages are lost from logs. Debugging relies on error names, codes, stack frames and traces instead.
