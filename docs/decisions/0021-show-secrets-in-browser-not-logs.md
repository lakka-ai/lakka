# 0021. Generated secrets are shown in the browser, never in logs

Status: accepted; widened by ADR 0115 (`lakka recovery-key` prints the key to its own output).

## Context

The tech spec says generated secrets are "shown once, with a clear warning to save them". Invariant 9 forbids credentials in logs at any level.

## Decision

Secret values are never written to logs or container output. Secrets that need saving, such as the credential master key, are shown once on the first-run setup screen in the browser (AD-1), with a warning. Logs and `init` output only name which secrets were generated and where they live.

## Consequences

- `docker compose logs` output is always safe to share (NF-O3).
- The first-run setup screen must show the master key before setup completes. After that, only a backup (AD-2) recovers it.
