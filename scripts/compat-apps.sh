#!/usr/bin/env bash
# Starts Open WebUI and LibreChat against the running stack and runs their checks (AC 14, API-6,
# ADR 0064). Run `pnpm test:compat` first: it prepares the stack and writes
# test/compat/.state.json, whose key both products are configured with.
set -euo pipefail
cd "$(dirname "$0")/.."
test -f test/compat/.state.json || { echo "run pnpm test:compat first" >&2; exit 1; }
LAKKA_COMPAT_KEY=$(node -p "require('./test/compat/.state.json').key")
random() { node -p "require('node:crypto').randomBytes($1).toString('hex')"; }
export LAKKA_COMPAT_KEY
export COMPAT_WEBUI_SECRET=$(random 32)
export COMPAT_LIBRECHAT_CREDS_KEY=$(random 32)
export COMPAT_LIBRECHAT_CREDS_IV=$(random 16)
export COMPAT_LIBRECHAT_JWT_SECRET=$(random 32)
export COMPAT_LIBRECHAT_JWT_REFRESH_SECRET=$(random 32)
docker compose -f compose.yaml -f docker/compose.e2e.yaml -f docker/compose.compat.yaml \
  up -d --wait open-webui librechat
exec pnpm exec vitest run --config vitest.compat-apps.config.ts
