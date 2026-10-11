# 0011. Caddy image built on Debian slim

Status: accepted

## Context

`CLAUDE.md` forbids Alpine images. The official Caddy image is Alpine-based and has no Debian variant.

## Decision

`docker/caddy.Dockerfile` starts from `debian:trixie-slim`, installs `ca-certificates`, and copies the statically linked `/usr/bin/caddy` from the pinned official image (`caddy:2.11.4`). Nothing runs on Alpine; the official image is only a build stage.

## Consequences

- One more image to build and eventually publish.
- The Caddy version is pinned in one build argument.
- Caddy runs as root, like the official image does, so it can bind ports 80 and 443. Running it as a non-root user is a hardening item for later.
