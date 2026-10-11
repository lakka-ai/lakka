# 0014. One app image for every process

Status: accepted

## Context

api, worker, web and the init job all need Node 24 and the workspace sources. Separate images would mean several multi-arch builds and several versions to keep in step.

## Decision

One image, built from `docker/Dockerfile` on `node:24.21.0-trixie-slim`. The entrypoint takes a subcommand: `lakka api|worker|web|init`. Compose runs the same image four times with different commands. Caddy has its own image (ADR 0011).

## Consequences

- One multi-arch build and one version tag per release.
- Each process carries the others' dependencies. That is well within the 1 GB image budget (NF-D6), and the classifier weights are stored once.
- The image is Debian slim, never Alpine, as onnxruntime-node requires.
