# 0043. Classifier service: runtime, compiling and scoring

Status: accepted

## Context

- RT-4: classification runs in process with no network call.
- Invariant 10: routing is optional; if the classifier fails to load, everything else works.
- The tech spec compiles centroids when a policy is saved, caches query embeddings, and skips very short messages.
- The performance limits require classification under 100 ms at p95 on the reference hardware of 2 vCPU and 4 GB (NF-D8).
- ADR 0022 chose the model and runtime. ADR 0042 stores embeddings with the model that produced them.

## Decision

- **Model identity.** An embedder's id is its directory name plus the first 12 hex digits of the SHA-256 of its weights, for example `all-MiniLM-L6-v2@afdb6f1a0e45`. Every stored embedding records it, so vectors from different models, or different weights under the same name, are never compared.
- **Lazy runtime.** The api process loads the embedder the first time something needs an embedding, not at startup.
  - Concurrent callers share one load.
  - A failed load marks routing unavailable, and callers carry on as if routing were off. The load is retried a minute later, so a transient failure does not last until the next restart.
  - A per-process LRU cache of 1000 query embeddings, keyed by the text with whitespace collapsed, sits in front of the model. It is in memory only; the text is never stored or logged.
- **Compiling.** Saving a route embeds every example that lacks an embedding from the current model, then replaces the workspace's centroids (the unit-length mean of each route's examples) and bumps `policy_version`.
  - A route with no examples has no centroid, and the classifier can never choose it.
  - Without a classifier, saving still works and routes stay uncompiled.
  - Routes left behind by a model change are recompiled when they are next used. The admin tool recompiles before scoring; requests will do it in the background.
- **Policy snapshots.** A request reads the workspace's routing policy once, into a frozen snapshot cached in memory per workspace.
  - Each use checks `policy_version` with one primary-key read and reloads only when it moved.
  - The reload is a single repeatable-read transaction, so a snapshot's rows and version always match.
- **Scoring** is a pure function over a snapshot. Similarity is the dot product of unit vectors, only against vectors from the current model, only for enabled routes. Messages of fewer than three words are not classified.
  - Two modes exist: centroid and nearest example. Centroid is the default; the routing evaluation compares them (ADR 0045).
- **Try a phrase.** `POST /api/workspaces/:id/routing/try` scores a phrase for admins (`policy.read`) and lists enabled routes with nothing to learn from. The phrase is used for that call only.
- **Latency.** `lakka embed-bench` now times a whole classification: a message not seen before, embedded and scored against eight routes of three examples each. CI runs it in the image job on amd64 and arm64 with `--cpus 2`, the reference hardware, and fails above 100 ms at p95. Locally on Apple silicon, p95 is about 2 ms.
- **Tests without the model.** Integration tests use a deterministic fake embedder (hashed bag of words) behind the same interface. The real model is exercised by the image job's benchmark, and by the routing evaluation (ADR 0045).

## Consequences

- The first request that needs a classification pays the model load, about 130 ms (Spike A), after which only the embedding does.
- A workspace with many routes and long example lists compiles in the time it takes to embed the new examples, typically well under a second for an admin save.
- Recompiling after a model change needs no migration and no operator step.
