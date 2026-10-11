# 0025. Streaming transport and the commitment window

Status: accepted; its plan to remove the spike routes in M2 is superseded by ADR 0040, its shutdown "at once" is replaced by ADR 0081, and the spike routes, `LAKKA_ENABLE_SPIKE_ROUTES` and `docker/compose.spike.yaml` are removed by ADR 0064.

## Context

CLAUDE.md invariant 6 and the tech spec require first-chunk buffering: retry or fail over only before the first byte reaches the client, and surface errors after that. The spec also requires proxy buffering to be off in the Caddy configuration we ship. It does not settle how SSE is written from Fastify, what happens to HTTP headers during the window, or where the logic lives. Spike B settled these.

## Decision

- The window is a framework-free function in core, `commitFirstChunk(start, options)`. It retries an attempt that fails, ends empty, or produces no first chunk within `firstChunkTimeoutMs`, with full-jitter backoff and an optional `shouldRetry` for terminal errors. It resolves only once a first chunk exists. After that, failures become `StreamInterruptedError` and are never retried. Every attempt gets its own abort signal, linked to the caller's signal. Out of retries, it raises `UpstreamUnavailableError`.
- **HTTP headers are part of the window.** Nothing is written, not even the status line, until the first chunk exists. When no attempt commits, the client gets an ordinary JSON error with a real status code (502 `upstream_unavailable`). After commit, the client gets `event: error` with a machine-readable code inside the 200 stream.
- SSE is written with `reply.hijack()` and the raw response, not `@fastify/sse` (0.x). The hijack happens only at commit, so the error handler still answers failures before commit. Writes respect backpressure. A client disconnect (response `close` before end) aborts the stream, and the attempt with it.
- Stream responses set `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, the last for nginx-style proxies that customers may put in front of us (NF-C4).
- Caddy proxies api routes with `flush_interval -1`, and the Caddyfile has no `encode` directive.
- On shutdown (NF-O5), open streams are aborted in Fastify's `preClose` hook and end with `event: error` code `server_shutting_down`, so `close()` does not wait for them. ADR 0081 now lets them finish for up to 20 s first.
- The spike's own routes (`/api/spike/*`) exist only when `LAKKA_ENABLE_SPIKE_ROUTES=true`, which is off by default and set only by `docker/compose.spike.yaml`. They are removed when the M2 gateway provides real streams to test against.

## Consequences

- The M2 gateway builds on `commitFirstChunk` rather than designing its own window. Provider error classification (tech spec, Error classification) plugs in as `shouldRetry`.
- The first-chunk timeout adds to worst-case time to first token. The spike used 500 ms and 3 attempts; M2 sets real values per provider.
- Partial usage on an aborted or interrupted stream still has to be counted and reconciled (invariant 4). The window hands over the abort; the budget engine in M4 must hook in at the same place.
- With `hijack()`, Fastify's `onResponse` hook does not run for committed streams, so the stream handler logs its own completion.
