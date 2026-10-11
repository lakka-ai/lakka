#!/usr/bin/env bash
# NF-O5 through Caddy (ADR 0081): stopping the api lets an open completion stream run for the
# 20 s drain, then ends it with an error event, and the api is gone well before compose's 30 s
# stop grace period would kill it. Uses the key and the idle model `pnpm test:compat` prepared
# (test/compat/.state.json); the idle model sends one chunk and then nothing, so the stream is
# still open when the drain ends. Neither the key nor the model is printed.
set -euo pipefail
cd "$(dirname "$0")/.."
state=test/compat/.state.json
out=test-results/compat-shutdown.out
mkdir -p test-results
key=$(node -p "require('./$state').key")
base=$(node -p "require('./$state').baseUrl")
body=$(node -p "JSON.stringify({ model: require('./$state').models.idle, stream: true, messages: [{ role: 'user', content: 'Tell me a long story' }] })")
curl -sN "$base/v1/chat/completions" \
  -H "authorization: Bearer $key" -H 'content-type: application/json' -d "$body" > "$out" &
sleep 2
start=$(date +%s%N)
# No -t: the service's stop_grace_period applies, as it does for an operator.
docker compose stop api
elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
wait
echo "api stopped in ${elapsed} ms"
# The api's own account of its shutdown: event names and timings, never content (NF-S5).
docker compose logs --no-color api | grep -E '"msg":"api\.(stop|drain)' | tail -n 10 || true
tail -n 2 "$out"
grep -q '"code":"server_shutting_down"' "$out"
# The drain, the 2 s wait for ended streams to be written, and some slack; not a kill at 30 s.
test "$elapsed" -ge 20000
test "$elapsed" -lt 25000
