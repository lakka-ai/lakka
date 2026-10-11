#!/bin/sh
# Entry point for the app image. The first argument picks the process.
set -eu

command="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi

case "$command" in
  api) exec node /app/apps/api/src/main.ts "$@" ;;
  worker) exec node /app/apps/worker/src/main.ts "$@" ;;
  web) exec node /app/apps/web/server.ts "$@" ;;
  init) exec node /app/apps/api/src/cli/init-secrets.ts "$@" ;;
  migrate) exec node /app/apps/api/src/cli/migrate.ts "$@" ;;
  create-user) exec node /app/apps/api/src/cli/create-user.ts "$@" ;;
  setup-code) exec node /app/apps/api/src/cli/setup-code.ts "$@" ;;
  recovery-key) exec node /app/apps/api/src/cli/recovery-key.ts "$@" ;;
  credential-key) exec node /app/apps/api/src/cli/credential-key.ts "$@" ;;
  embed-bench) exec node /app/apps/api/src/cli/embed-bench.ts "$@" ;;
  classifier-eval) exec node /app/apps/api/src/cli/classifier-eval.ts "$@" ;;
  tool-runner) exec node /app/apps/api/src/cli/tool-runner.ts "$@" ;;
  egress) exec node /app/apps/api/src/cli/egress.ts "$@" ;;
  tool-host) exec node /app/apps/api/src/cli/tool-host.ts "$@" ;;
  diagnostics) exec node /app/apps/api/src/cli/diagnostics.ts "$@" ;;
  *)
    echo "usage: lakka api|worker|web|init|migrate|create-user|setup-code|recovery-key|credential-key|embed-bench|classifier-eval|tool-runner|tool-host|egress|diagnostics" >&2
    exit 64
    ;;
esac
