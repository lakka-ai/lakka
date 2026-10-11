# syntax=docker/dockerfile:1.7
#
# One image for every app process (ADR 0014): `lakka api|worker|web|init`.
# Debian slim, never Alpine: onnxruntime-node has no musl builds (CLAUDE.md, ADR 0014).

ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    pnpm_config_store_dir=/pnpm/store \
    CI=true \
    ONNXRUNTIME_NODE_INSTALL=skip
RUN corepack enable pnpm
WORKDIR /app

# Manifests first, so dependency layers stay cached until a manifest or the lockfile changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Fixes to dependencies, applied by the install (patchedDependencies in pnpm-workspace.yaml).
COPY patches ./patches
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

FROM manifests AS build
RUN --mount=type=cache,id=lakka-pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @lakka/web build

FROM manifests AS prod-deps
ARG TARGETARCH
RUN --mount=type=cache,id=lakka-pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod
# onnxruntime-node ships every platform's binaries in one tarball (about 300 MB). Keep only
# this image's architecture (NF-D6).
RUN set -eu; \
    ort="$(echo node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6)"; \
    case "$TARGETARCH" in amd64) keep=x64 ;; arm64) keep=arm64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac; \
    rm -rf "$ort/darwin" "$ort/win32"; \
    find "$ort/linux" -mindepth 1 -maxdepth 1 ! -name "$keep" -exec rm -rf {} +; \
    test -f "$ort/linux/$keep/onnxruntime_binding.node"
# drizzle-kit is an optional peer of better-auth that pnpm links from the workspace's own dev
# tools; nothing imports it at runtime, and it brings esbuild binaries built with old Go
# toolchains that the image scan rightly flags (NF-S7, ADR 0086). Nothing at runtime runs
# esbuild at all.
RUN set -eu; \
    cd node_modules/.pnpm; \
    rm -rf drizzle-kit@* @esbuild-kit+* esbuild@* @esbuild+*; \
    test -z "$(find . -path '*/bin/esbuild' -not -path '*/.bin/*')"

# Classifier weights are baked into the image; nothing downloads at boot (NF-D5, ADR 0022).
FROM base AS models
# One weight file per CPU family, for this image's architecture (ADR 0124).
ARG TARGETARCH
COPY models/manifest.json models/manifest.json
COPY models/reference models/reference
COPY models/licenses models/licenses
COPY scripts/models.ts scripts/fetch-models.ts scripts/
RUN node scripts/fetch-models.ts

FROM ${NODE_IMAGE} AS runtime
# Debian's security fixes, which reach its archive before the Node image is rebuilt with them
# (NF-S7, ADR 0099). The base image's npm and corepack are never used at runtime, and npm's own
# dependencies are what the image scan flags there (ADR 0086).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# ONNX Runtime telemetry is on by default; the embedder also sets this in code (ADR 0024).
ENV NODE_ENV=production \
    ORT_DISABLE_TELEMETRY=1
WORKDIR /app
# Production node_modules and manifests, then sources. api and worker run TypeScript directly
# with Node's type stripping, so there is no compile step (ADR 0013).
COPY --from=prod-deps /app ./
COPY packages ./packages
COPY apps ./apps
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=models /app/models ./models
COPY docker/entrypoint.sh /usr/local/bin/lakka
# What this image was built from, for the diagnostics bundle (ADR 0083) and the AGPL source link
# (ADR 0085). The release pipeline sets them; a build from source says so. Last, so a new
# version reuses every layer above.
ARG LAKKA_VERSION=dev
ARG LAKKA_REVISION=unknown
ENV LAKKA_VERSION=${LAKKA_VERSION} \
    LAKKA_REVISION=${LAKKA_REVISION}
LABEL org.opencontainers.image.title="Lakka" \
      org.opencontainers.image.description="Self-hosted AI control plane" \
      org.opencontainers.image.source="https://github.com/lakka-ai/lakka" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${LAKKA_VERSION}" \
      org.opencontainers.image.revision="${LAKKA_REVISION}"
USER node
ENTRYPOINT ["lakka"]
CMD ["api"]
