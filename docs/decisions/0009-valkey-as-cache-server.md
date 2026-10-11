# 0009. Valkey 9 as the cache server

Status: accepted

## Context

The docs say Redis 7 or later. The `redis:7` image resolves to 7.4, which is licensed RSALv2 or SSPLv1, and `CLAUDE.md` forbids SSPL. Redis 7.2 is BSD but a 2023 line; Redis 8 adds an AGPLv3 option.

## Decision

Ship Valkey 9 (`valkey/valkey:9.1.2-trixie`, BSD-3-Clause, Linux Foundation) as the cache server. Everything the docs say about "Redis" applies to Valkey. NF-C2 is read as "a server speaking the Redis 7.2 protocol or later".

## Consequences

- No license change can be imposed by a single vendor.
- Customers who bring their own Redis 7.2 or later should still work. We will test that when an external cache becomes a supported configuration.
- The docs keep saying Redis; this ADR is the mapping.
