# 0015. srvx serves the web app in production

Status: accepted

## Context

TanStack Start (a release candidate) can produce a Node server through Nitro, but the `nitro` package is still beta. Without Nitro, the build produces a fetch handler plus client assets that any Node server can run.

## Decision

`apps/web/server.ts` serves the build with `srvx` 1.0.5 (MIT, h3js, stable): static files from `dist/client` and everything else through the SSR fetch handler.

## Consequences

- The runtime only depends on stable 1.x packages.
- The runtime needs web's production `node_modules`, which the single image already has (ADR 0014).
- If Nitro reaches a stable release and offers something we need, switching is a change to one file.
