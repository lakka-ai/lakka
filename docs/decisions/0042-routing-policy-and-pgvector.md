# 0042. Routing policy data and pgvector

Status: accepted

## Context

RT-1 and RT-2 give each workspace named routes with example phrasings. RT-5 sets a threshold for each direction. RT-11 lets routing be turned off. The tech spec's data model stores example and centroid embeddings as `vector(384)`. NF-A3 makes the embedding model a setting. The M3 plan chose pgvector over plain arrays (E2, the user's decision), and settled signals (E5), policy freshness (E9), who manages routes (E10) and per-route failover (E13).

## Decision

- **pgvector.**
  - The bundled Postgres is the pgvector image built on the same Debian and Postgres versions as before: `pgvector/pgvector:0.8.6-pg18-trixie`, which is Postgres 18.6. CI's integration matrix runs the PG16 and PG18 variants (16.15 and 18.6).
  - Migration 0007 runs `CREATE EXTENSION IF NOT EXISTS vector`. An external Postgres must have pgvector 0.8 or later installed, or be one where our role may create it.
  - pgvector is released under the PostgreSQL License.
  - It is an extension of the existing database, not a new stateful dependency (invariant 11).
- **Embeddings have no fixed dimension.** Columns are plain `vector`, and each row records the embedding model that produced it. A different model (NF-A3) then needs recompiling, not a migration. Drizzle's column type insists on a dimension, so a small custom type maps `number[]` to pgvector's text form.
- **Tables:**
  - `routes`: name (unique per workspace), description, model, up to five fallbacks, allow-other-providers flag, down and up thresholds, enabled flag, claimed signals.
  - `route_examples`: the text as typed, its position, and its embedding.
  - `route_centroids`: the embedding, its model, example count and time computed.

  Thresholds are double precision. A check keeps `threshold_down >= threshold_up` (RT-5) and both within (0, 1]. Examples keep the admin's order.

- **Workspace settings:** `routing_enabled` (RT-11), `default_model` (RT-6), `pinned_model` (RT-3), and `policy_version`. Every policy write bumps the version in the same transaction, so a cached snapshot can check freshness with one primary-key read (E9).
- **Validation.** A route, fallback, default or pinned model must be usable in the workspace: known and priced (BG-4), with a credential for its provider there (PR-8). Without the cross-provider flag, fallbacks must share the route model's provider, because dispatch would skip the others (ADR 0040).
- **Signals** come from a fixed list: `code_fence` and `code_file` in M3, with attachment signals in M5. A signal may be claimed by at most one route in a workspace, so a match is never ambiguous.
- **Who manages policy.** Workspace admins and instance admins manage it (`policy.read`, `policy.manage`). Members cannot see it, and keys cannot touch it. Members and keys can list the models their workspace can use.
- **Editing examples.** Unchanged texts keep their embeddings. Any change to the set of examples drops the route's centroid until it is recompiled.

## Consequences

- Operators on the bundled stack notice nothing; the image carries the same Postgres build. Operators on their own Postgres need the extension, and the startup migration fails with Postgres's own error if it is missing.
- Classification can use either the in-memory policy snapshot or pgvector queries; the routing evaluation (ADR 0045) decides between centroid and nearest-example matching.
