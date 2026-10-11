#!/usr/bin/env bash
# Runs the official OpenAI Python SDK against the running stack (AC 15, ADR 0064), from a python
# container on the compose network. Run `pnpm test:compat` first: it prepares the stack and
# writes test/compat/.state.json.
set -euo pipefail
cd "$(dirname "$0")/.."
test -f test/compat/.state.json || { echo "run pnpm test:compat first" >&2; exit 1; }
exec docker run --rm \
  --network "${COMPOSE_PROJECT_NAME:-lakka}_default" \
  -e LAKKA_COMPAT_API_BASE=http://caddy/v1 \
  -v "$PWD/test/compat:/compat:ro" \
  python:3.13.9-slim-trixie \
  sh -c 'pip install --quiet --disable-pip-version-check --root-user-action=ignore -r /compat/python/requirements.txt && python /compat/python/check_sdk.py'
