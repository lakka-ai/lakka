# 0023. NF-D6 covers our images only

Status: accepted

## Context

NF-D6 says total pulled image size must stay under 1 GB. It did not say whether the Postgres and Valkey images count.

## Decision

The budget covers the images we build and publish: `lakka/app` and `lakka/caddy`, per architecture. Upstream Postgres and Valkey images are excluded. `docker/image-size.sh` measures the gzip size of `docker image save`, which approximates registry layer compression. CI fails if the total goes over 1,000,000,000 bytes.

## Consequences

- At the end of Spike A the total was 188 MB on linux/arm64 (app 142 MB, Caddy 46 MB), so there is room, but the check stays in CI to catch regressions.
- The measurement is approximate. The release pipeline can switch to exact registry sizes once images are published.
