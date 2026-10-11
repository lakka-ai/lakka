#!/usr/bin/env bash
# The upgrade path (NF-O6, ADR 0075 H7, ADR 0086): run the earlier version, fill it with data,
# upgrade to this commit in place, on the same volumes, and check the data survived and works.
#
# The earlier version is LAKKA_UPGRADE_FROM if set; otherwise the latest v* tag; otherwise,
# before the first release, main's previous merge: the merge base with main on a branch, or the
# first parent on main itself. A repository's first commit has none of these, so the test says
# so and passes there.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(pwd)

from=${LAKKA_UPGRADE_FROM:-}
if [ -z "$from" ]; then
  from=$(git describe --tags --match 'v*' --abbrev=0 HEAD 2> /dev/null || true)
fi
if [ -z "$from" ]; then
  main=$(git rev-parse --verify -q origin/main || git rev-parse --verify -q main)
  from=$(git merge-base HEAD "$main")
  [ "$from" != "$(git rev-parse HEAD)" ] || from=$(git rev-parse --verify -q 'HEAD^1' || true)
fi
if [ -z "$from" ]; then
  # A shallow clone hides the parent it has; only a real first commit has nothing to upgrade from.
  if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
    echo "upgrade: no earlier version in a shallow clone; fetch the full history" >&2
    exit 1
  fi
  echo "upgrade: skipped: no v* tag, and HEAD is the first commit, so there is no earlier version"
  exit 0
fi
echo "upgrade: from $(git rev-parse --short "$from") to $(git rev-parse --short HEAD)"

work=$(mktemp -d "${TMPDIR:-/tmp}/lakka-upgrade.XXXXXX")
export COMPOSE_PROJECT_NAME=lakka-upgrade
export LAKKA_HTTP_PORT=18380 LAKKA_HTTPS_PORT=18743
export LAKKA_E2E_URL=http://127.0.0.1:18380
export COMPOSE_FILE=compose.yaml:docker/compose.e2e.yaml
base=$LAKKA_E2E_URL
cleanup() {
  (cd "$repo" && docker compose down -v --remove-orphans > /dev/null 2>&1) || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/from"
git archive "$from" | tar -x -C "$work/from"
export UPGRADE_EMAIL="upgrade-admin@example.com"
UPGRADE_PASSWORD="upgrade password $(node -p 'require("node:crypto").randomBytes(6).toString("hex")')"
export UPGRADE_PASSWORD

echo "upgrade: starting the earlier version"
(
  cd "$work/from"
  docker compose up -d --build --wait
  printf '%s' "$UPGRADE_PASSWORD" | docker compose exec -T api lakka create-user \
    --email "$UPGRADE_EMAIL" --name 'Upgrade Admin' --instance-admin > /dev/null
)
node test/upgrade/data.ts fill "$base" "$work/state.json"
before=$(docker compose exec -T postgres psql -U lakka -d lakka -Atc 'select count(*) from drizzle.__drizzle_migrations')

echo "upgrade: upgrading in place"
docker compose up -d --build --wait
after=$(docker compose exec -T postgres psql -U lakka -d lakka -Atc 'select count(*) from drizzle.__drizzle_migrations')
echo "upgrade: migrations applied $before, then $after"
test "$after" -ge "$before"
test "$after" -eq "$(ls packages/db/migrations/*.sql | wc -l | tr -d ' ')"
node test/upgrade/data.ts verify "$base" "$work/state.json"
