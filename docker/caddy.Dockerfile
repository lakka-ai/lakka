# syntax=docker/dockerfile:1.7
#
# Caddy on Debian slim (ADR 0011). The official image is Alpine-based, and its binary carries
# fixable vulnerabilities in its Go toolchain and modules, so we compile the same Caddy release
# ourselves, from docker/caddy (ADR 0086): go.mod pins the release and the fixed modules, go.sum
# every hash. Only the static binary goes into the image; nothing runs on Alpine.

ARG GO_IMAGE=golang:1.26.9-trixie
ARG DEBIAN_IMAGE=debian:trixie-slim

FROM ${GO_IMAGE} AS caddy
WORKDIR /src
COPY docker/caddy/go.mod docker/caddy/go.sum ./
RUN --mount=type=cache,id=lakka-go-mod,target=/go/pkg/mod go mod download
COPY docker/caddy/main.go ./
RUN --mount=type=cache,id=lakka-go-mod,target=/go/pkg/mod \
    --mount=type=cache,id=lakka-go-build,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o /usr/bin/caddy . \
 && /usr/bin/caddy version

FROM ${DEBIAN_IMAGE}
# With Debian's security fixes, which reach its archive before the base image is rebuilt with
# them (NF-S7, ADR 0099).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY docker/Caddyfile /etc/caddy/Caddyfile
ENV XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data
VOLUME ["/config", "/data"]
EXPOSE 80 443
ARG LAKKA_VERSION=dev
ARG LAKKA_REVISION=unknown
LABEL org.opencontainers.image.title="Lakka Caddy" \
      org.opencontainers.image.source="https://github.com/lakka-ai/lakka" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${LAKKA_VERSION}" \
      org.opencontainers.image.revision="${LAKKA_REVISION}"
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
