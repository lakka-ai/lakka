# 0010. Ship Postgres 18, support 16 and later

Status: accepted

## Context

NF-C2 sets Postgres 16 as the minimum. Major upgrades of a Postgres container need a manual dump and restore, so whatever default we ship at first becomes hard to move away from.

## Decision

The compose file ships Postgres 18 (`postgres:18.6-trixie`, Debian). Integration tests run against 16 as the supported minimum.

## Consequences

- New installs start on the newest major, with the longest support window.
- Features newer than 16 (for example the built-in `uuidv7()`) must not be used, or the minimum must be raised deliberately.
- The Postgres 18 image stores data under `/var/lib/postgresql`, so the volume is mounted there.
