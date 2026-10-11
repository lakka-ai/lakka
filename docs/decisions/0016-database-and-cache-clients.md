# 0016. Postgres and Valkey client libraries

Status: accepted

## Context

We need one Postgres driver for Drizzle and pg-boss, and one client for Valkey that can run Lua scripts atomically (budget reservation, BG-3).

## Decision

- Postgres: `pg` 8.23 (MIT). pg-boss already depends on it. postgres.js is Unlicense (not on the allowed list) and has had no release since April 2026.
- Valkey: `@valkey/valkey-glide` 2.5 (Apache-2.0, maintained by the Valkey project). It has `Script` plus `invokeScript` for EVALSHA with fallback, and ships prebuilt glibc binaries for linux x64 and arm64 with no install script.
- GLIDE's native logger is turned off (ADR 0005). The cache client connects lazily and retries on the next call, so a process can start while Valkey is booting.

## Consequences

- GLIDE is a native addon, which adds a second native dependency alongside onnxruntime-node. Both publish glibc builds for amd64 and arm64.
- Its transitive `protobufjs` has a postinstall script, which is denied in `pnpm-workspace.yaml`; the script only prints a warning.
