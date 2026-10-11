# Spike B: SSE through Caddy with the commitment window

Milestone M1. Decision: ADR 0025.

Update: the spike routes, `docker/compose.spike.yaml` and `scripts/spike-sse.ts` are removed. The same properties are now checked with real completions: the official SDKs stream through Caddy unbuffered (`test/compat`), the commitment window is covered by the gateway and `/v1` integration tests, and CI's shutdown check streams a completion through Caddy (`scripts/compat-shutdown.sh`). See ADR 0064.

## Question

Can Fastify stream SSE through our shipped Caddy configuration so that (1) a failure before the first chunk is retried without the client noticing, (2) a failure after the first chunk surfaces as an error, and (3) the proxy does not buffer? This shapes the M2 gateway (CLAUDE.md invariant 6).

## Answer

Yes, on amd64 and arm64. Holding HTTP headers until the first chunk turned out to be part of the answer: it lets a request with no successful attempt return a normal JSON 502, not a broken 200 stream.

## Method

- `commitFirstChunk` in `packages/core/src/gateway/commit.ts` implements the window. A spike route, `/api/spike/stream`, runs a fake provider through it. The fake provider can fail, stall or break mid-stream on request. The route is enabled only by `docker/compose.spike.yaml`.
- `pnpm spike:sse` (`scripts/spike-sse.ts`) runs on the host and goes through Caddy on `127.0.0.1:8080`, like a real client. It timestamps every SSE event as it arrives.
- The negative control asks the server to hold all chunks and send them at the end. The buffering check must flag that stream, which shows the measurement can actually fail.
- The CI job `stack` starts the full compose stack on GitHub's native `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` runners. It runs the harness, then stops the api mid-stream.

## Results (CI, native runners)

| Check                                             | amd64                                                        | arm64                          |
| ------------------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| Chunks sent every 200 ms arrive every             | 187 to 202 ms                                                | 194 to 201 ms                  |
| Negative control (server-buffered) arrival spread | 0 ms, flagged                                                | 0 ms, flagged                  |
| 2 failures before first chunk                     | clean stream, 3rd attempt served, no error visible           | same                           |
| First chunk stalls past the 500 ms window         | retried, first event at 593 ms                               | retried, first event at 545 ms |
| Every attempt fails before first chunk            | HTTP 502 JSON `upstream_unavailable`                         | same                           |
| Failure after 3 chunks                            | 3 events, then `event: error` `stream_interrupted`; no retry | same                           |
| Client disconnects after 3 events                 | server aborted the stream within 5 ms                        | within 4 ms                    |
| `docker compose stop api` mid-stream              | stopped in 219 ms; stream ended with `server_shutting_down`  | 203 ms, same                   |

The same checks passed locally on linux/arm64 (Docker Desktop).

## Findings

1. Caddy 2.11 with `flush_interval -1` passes SSE chunks through without measurable delay. There must be no `encode` directive on streaming routes.
2. Headers belong inside the window. Once the status line is sent, a request that never got a good attempt can only fail inside a 200 stream.
3. `reply.hijack()` at commit time keeps Fastify's error handler for the failures before commit. The cost is that `onResponse` no longer runs for committed streams, so the handler logs its own completion.
4. Client disconnects show up as the response's `close` event before the response ends. That is the hook where M4 reconciles partial usage.
5. Aborting streams in `preClose` keeps shutdown fast. Without it, an open stream blocks `close()` until its own timeout.

## For M2

- Build the gateway on `commitFirstChunk`. Plug provider error classification into `shouldRetry`, and set the first-chunk timeout and retry count per provider rather than using the spike's 500 ms and 3 attempts.
- Add the inactivity timeout from the tech spec (a stream that opens and then stalls). The spike covers only the first-chunk timeout.
- Delete `/api/spike/*`, `LAKKA_ENABLE_SPIKE_ROUTES` and `docker/compose.spike.yaml`, and point the harness at the real endpoint with a fake provider.
