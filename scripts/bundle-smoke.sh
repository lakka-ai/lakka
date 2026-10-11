#!/usr/bin/env bash
# The release bundle as a customer runs it (AC 1, 2 and 3; NF-D1, NF-D5, NF-D7; ADR 0086). Takes
# images already built, makes a bundle that names them, and in a directory of its own:
#   AC 1  `docker compose up` reaches the first-run screen, with no edits and no errors logged;
#   AC 3  that takes under 30 seconds from `up`, with the images present;
#   AC 2  on a network with no route out, it starts again from nothing and serves requests,
#         the classifier included, while nothing inside can reach the internet.
# The image size budget (AC 3) is checked by docker/image-size.sh in the image job.
#
#   scripts/bundle-smoke.sh <app image> <caddy image>
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(pwd)
app=${1:?app image}
caddy=${2:?caddy image}
limit_ms=${LAKKA_COLD_START_LIMIT_MS:-30000}
port=${LAKKA_BUNDLE_HTTP_PORT:-18280}

work=$(mktemp -d "${TMPDIR:-/tmp}/lakka-bundle.XXXXXX")
export COMPOSE_PROJECT_NAME=lakka-bundle LAKKA_HTTP_PORT=$port LAKKA_HTTPS_PORT=$((port + 363))
cleanup() {
  (cd "$work/lakka-v0.0.0-smoke" 2>/dev/null && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -rf "$work"
}
trap cleanup EXIT

postgres=$(grep -m1 -o 'pgvector/pgvector:[^ ]*' docker/compose.yaml)
valkey=$(grep -m1 -o 'valkey/valkey:[^ ]*' docker/compose.yaml)
node scripts/release-bundle.ts --version v0.0.0-smoke --out "$work" --allow-tags \
  --image "lakka/app:local=$app" --image "lakka/caddy:local=$caddy" \
  --image "$postgres=$postgres" --image "$valkey=$valkey" > /dev/null
tar -xzf "$work/lakka-v0.0.0-smoke.tar.gz" -C "$work"
cd "$work/lakka-v0.0.0-smoke"
docker pull -q "$postgres" > /dev/null
docker pull -q "$valkey" > /dev/null

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

echo "bundle-smoke: AC 1, 3: up from the bundle to the first-run screen"
start=$(now_ms)
docker compose up -d
# grep reads the whole page rather than -q stopping early, which under pipefail would fail the
# check when curl's write is cut off.
until curl -fsSL "http://127.0.0.1:$port/" 2> /dev/null | grep 'Set up Lakka' > /dev/null; do
  [ $(($(now_ms) - start)) -lt 120000 ] || { echo "bundle-smoke: no first-run screen after 2 minutes" >&2; docker compose logs --no-color | tail -50; exit 1; }
  sleep 0.25
done
elapsed=$(($(now_ms) - start))
echo "bundle-smoke: first-run screen after ${elapsed} ms (limit ${limit_ms} ms)"
docker compose up -d --wait > /dev/null
if docker compose logs --no-color api worker web sandbox egress | grep -E '"level":"(error|fatal)"'; then
  echo "bundle-smoke: errors logged on a clean start" >&2
  exit 1
fi
test "$elapsed" -lt "$limit_ms"
docker compose down -v --remove-orphans > /dev/null 2>&1

echo "bundle-smoke: AC 2: from nothing, on a network with no route out"
offline=(-f compose.yaml -f "$repo/docker/compose.offline.yaml")
docker compose "${offline[@]}" up -d --wait
in_api() { docker compose "${offline[@]}" exec -T api node -e "$1"; }
# Serves the first-run screen through Caddy, and is healthy with its classifier loaded.
in_api "fetch('http://caddy/', { redirect: 'follow' }).then(async (r) => { const t = await r.text(); process.exit(r.ok && t.includes('Set up Lakka') ? 0 : 1); }, () => process.exit(1))"
in_api "fetch('http://127.0.0.1:3000/healthz').then(async (r) => { const h = await r.json(); process.exit(h.checks.database.status === 'ok' && h.checks.cache.status === 'ok' && h.checks.classifier.status === 'ok' ? 0 : 1); }, () => process.exit(1))"
# And really cannot reach out.
if in_api "fetch('https://example.com', { signal: AbortSignal.timeout(5000) }).then(() => process.exit(0), () => process.exit(1))"; then
  echo "bundle-smoke: the offline network reached the internet" >&2
  exit 1
fi
echo "bundle-smoke: the bundle starts, serves, and needs no internet to do it"
