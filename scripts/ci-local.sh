#!/usr/bin/env bash
# The CI workflow's jobs on this machine, for when GitHub Actions cannot run (ADR 0065). Tests the
# current commit from a clean clone in a temporary directory, as CI would, on this machine's own
# architecture only: the amd64 and arm64 legs of the image and stack jobs are the same steps, and
# emulating the other architecture is too slow to be worth it.
#
#   pnpm ci:local                  every job: check, dco, site, integration (Postgres 16 and 18),
#                                  image, out-of-process, upgrade, stack
#   pnpm ci:local stack image      only the jobs named
#
# The stack runs as its own compose project on its own ports, so a stack already running on this
# machine is left alone. Uncommitted changes are not tested. The clone and its logs are removed
# when every job passes and kept when one fails, or always with LAKKA_CI_LOCAL_KEEP=1.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)

# The Node version CI uses; fnm, if present, provides it.
want="v$(cat "$repo/.nvmrc")"
if [ "$(node --version 2>/dev/null || true)" != "$want" ]; then
  if command -v fnm >/dev/null && [ -z "${LAKKA_CI_LOCAL_NODE:-}" ]; then
    exec env LAKKA_CI_LOCAL_NODE=1 fnm exec --using "${want#v}" -- bash "$0" "$@"
  fi
  echo "ci:local needs Node $want (.nvmrc); found $(node --version 2>/dev/null || echo none)" >&2
  exit 1
fi

jobs=("$@")
[ ${#jobs[@]} -gt 0 ] || jobs=(check dco site integration-pg16 integration-pg18 image out-of-process upgrade stack)
for job in "${jobs[@]}"; do
  case "$job" in
    check | dco | site | integration-pg16 | integration-pg18 | image | out-of-process | upgrade | stack) ;;
    *) echo "unknown job: $job (check, dco, site, integration-pg16, integration-pg18, image, out-of-process, upgrade, stack)" >&2; exit 2 ;;
  esac
done

commit=$(git -C "$repo" rev-parse HEAD)
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "note: uncommitted changes are not tested; testing $(git -C "$repo" rev-parse --short HEAD)"
fi

# Under /tmp or TMPDIR, which Docker Desktop shares, so compose can bind-mount from the clone.
work=$(mktemp -d "${TMPDIR:-/tmp}/lakka-ci.XXXXXX")
mkdir -p "$work/logs"
git clone --quiet "$repo" "$work/repo"
git -C "$work/repo" checkout --quiet --detach "$commit"
cd "$work/repo"

# The stack's own project, ports and addresses, away from anything already running.
export COMPOSE_PROJECT_NAME=lakka-ci
export LAKKA_HTTP_PORT=18080
export LAKKA_HTTPS_PORT=18443
export LAKKA_E2E_URL=http://127.0.0.1:18080
export LAKKA_COMPAT_URL=http://127.0.0.1:18080
export LAKKA_COMPAT_OPEN_WEBUI_PORT=18181
export LAKKA_COMPAT_OPEN_WEBUI_URL=http://127.0.0.1:18181
export LAKKA_COMPAT_LIBRECHAT_PORT=13080
export LAKKA_COMPAT_LIBRECHAT_URL=http://127.0.0.1:13080
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
stack=(docker compose -f compose.yaml -f docker/compose.e2e.yaml)

teardown() { "${stack[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap teardown EXIT

run_check() {
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm lint
  pnpm lint:workflows
  pnpm format:check
  pnpm check:copy
  pnpm test
  pnpm exec playwright install chromium
  pnpm test:stories
  # The committed migrations must match the Drizzle schema (ADR 0026).
  pnpm db:generate
  test -z "$(git status --porcelain -- packages/db/migrations)" || {
    git status --porcelain -- packages/db/migrations
    echo "schema changed without a migration" >&2
    return 1
  }
}

run_dco() {
  # The commits this branch adds to main, signed off by their authors (ADR 0002).
  scripts/check-dco.sh
}

run_site() {
  pnpm install --frozen-lockfile
  pnpm exec playwright install chromium webkit firefox
  # The three engines CI runs one to a leg, here in one run.
  pnpm site:check
}

run_integration() {
  pnpm install --frozen-lockfile
  LAKKA_TEST_POSTGRES_IMAGE="pgvector/pgvector:0.8.6-$1-trixie" pnpm test:integration
}

run_image() {
  docker build -f docker/Dockerfile -t lakka/app:ci-local .
  docker build -f docker/caddy.Dockerfile -t lakka/caddy:ci-local .
  for model in paraphrase-multilingual-MiniLM-L12-v2 paraphrase-multilingual-mpnet-base-v2; do
    for threads in 1 2; do
      gate=(--max-p95-ms 100)
      # mpnet is held to 200 ms at two threads, which amd64 needs; at one thread it is
      # reported, not gated (ADR 0123).
      if [ "$model" = paraphrase-multilingual-mpnet-base-v2 ]; then
        if [ "$threads" = 1 ]; then gate=(); else gate=(--max-p95-ms 200); fi
      fi
      # Two CPUs: the reference hardware (NF-D8) for the latency budget.
      docker run --rm --network none --cpus 2 \
        -e "LAKKA_CLASSIFIER_MODEL_DIR=/app/models/$model" lakka/app:ci-local embed-bench \
        --threads "$threads" \
        --reference "/app/models/reference/$model.json" \
        ${gate[@]+"${gate[@]}"}
    done
    docker run --rm --network none --cpus 2 \
      -e "LAKKA_CLASSIFIER_MODEL_DIR=/app/models/$model" lakka/app:ci-local classifier-eval \
      --min-accuracy 0.8
  done
  scripts/classifier-eval-languages.sh lakka/app:ci-local
  scripts/classifier-eval-languages.sh lakka/app:ci-local paraphrase-multilingual-mpnet-base-v2 0.78
  scripts/scan.sh lakka/app:ci-local lakka/caddy:ci-local
  scripts/bundle-smoke.sh lakka/app:ci-local lakka/caddy:ci-local
  sh docker/image-size.sh lakka/app:ci-local lakka/caddy:ci-local
}

run_out_of_process() {
  pnpm install --frozen-lockfile
  docker build -f docker/Dockerfile -t lakka/app:ci-local .
  LAKKA_RUNNER_IMAGE=lakka/app:ci-local pnpm test:out-of-process
}

run_upgrade() {
  scripts/upgrade-test.sh
}

run_stack() {
  pnpm install --frozen-lockfile
  teardown
  "${stack[@]}" up -d --build --wait
  curl -fsS "$LAKKA_E2E_URL/healthz"
  echo
  pnpm exec playwright install chromium
  # The stack is fresh, so first-run setup must run, not be skipped (ADR 0034).
  LAKKA_E2E_REQUIRE_FIRST_RUN=1 pnpm test:e2e
  pnpm test:compat
  pnpm --silent test:compat:python
  pnpm test:compat:apps
  pnpm test:sandbox
  scripts/diagnostics-bundle.sh
  scripts/backup-restore.sh
  scripts/compat-shutdown.sh
}

results=()
failed=0
for job in "${jobs[@]}"; do
  log="$work/logs/$job.log"
  started=$(date +%s)
  printf '%-18s running...' "$job"
  case "$job" in
    check) fn=(run_check) ;;
    dco) fn=(run_dco) ;;
    site) fn=(run_site) ;;
    integration-pg16) fn=(run_integration pg16) ;;
    integration-pg18) fn=(run_integration pg18) ;;
    image) fn=(run_image) ;;
    out-of-process) fn=(run_out_of_process) ;;
    upgrade) fn=(run_upgrade) ;;
    stack) fn=(run_stack) ;;
  esac
  # Each job stops at its first failing step, like a CI job; the next job still runs. Not run as
  # an `if` condition, where bash would ignore `set -e` inside it.
  set +e
  (
    set -euo pipefail
    "${fn[@]}"
  ) >"$log" 2>&1
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    status=passed
  else
    status=FAILED
    failed=1
  fi
  took=$(($(date +%s) - started))
  printf '\r%-18s %-7s %3dm%02ds\n' "$job" "$status" $((took / 60)) $((took % 60))
  results+=("$job $status")
  [ "$job" != stack ] || teardown
done

echo
echo "commit $(git rev-parse --short HEAD), $(uname -m), Node $(node --version)"
[ "$failed" -eq 0 ] && echo "all jobs passed"
if [ "$failed" -eq 0 ] && [ -z "${LAKKA_CI_LOCAL_KEEP:-}" ]; then
  cd /
  rm -rf "$work"
else
  echo "logs kept in $work/logs"
fi
exit "$failed"
