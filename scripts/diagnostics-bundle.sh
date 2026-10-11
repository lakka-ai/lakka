#!/usr/bin/env bash
# AD-3, AC 17 in the image (ADR 0083): the operator command writes a diagnostics bundle from the
# running api container, and no secret the instance was installed with appears in it, nor either
# of the sandbox's keys (ADR 0118). The files are read and compared inside the container, so no
# secret is ever printed here.
set -euo pipefail
cd "$(dirname "$0")/.."
out=test-results/diagnostics
rm -rf "$out"
mkdir -p "$out"
# The command's log lines go to stderr; kept, and shown if it fails, since they hold no secrets.
status=0
docker compose exec -T api lakka diagnostics > "$out/bundle.tar.gz" 2> "$out/stderr.log" ||
  status=$?
if [ "$status" -ne 0 ] || ! gzip -t "$out/bundle.tar.gz" 2>/dev/null; then
  echo "diagnostics: the command exited with $status and wrote $(wc -c < "$out/bundle.tar.gz") bytes" >&2
  # 137 is SIGKILL: in a container, almost always the kernel ending it for want of memory.
  [ "$status" -eq 137 ] && echo "diagnostics: it was killed, most likely out of memory" >&2
  echo "diagnostics: its log:" >&2
  cat "$out/stderr.log" >&2
  echo "diagnostics: memory of the containers:" >&2
  docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' >&2 || true
  exit 1
fi
tar -xzf "$out/bundle.tar.gz" -C "$out"
dir="$out/lakka-diagnostics"
for f in manifest system config health database cache instance jobs sandbox; do
  test -s "$dir/$f.json"
done
test -f "$dir/errors.jsonl"
grep -q '"via": "operator"' "$dir/manifest.json"
grep -q '"database"' "$dir/health.json"
# Asked of the running api, not loaded by the command (ADR 0083).
grep -q '"classifier"' "$dir/health.json"
# The api reaches the tool host and the egress proxy, and has both keys (ADR 0118).
grep -q '"toolHost": "ok"' "$dir/sandbox.json"
grep -q '"egress": "ok"' "$dir/sandbox.json"
grep -q '"toolHostToken": true' "$dir/sandbox.json"
grep -q '"egressKey": true' "$dir/sandbox.json"
cat "$dir"/* | docker compose exec -T api sh -c '
  bundle=$(cat)
  checked=0
  for f in /run/lakka/secrets/* /run/lakka/sandbox/* /run/lakka/egress/*; do
    value=$(cat "$f")
    [ -n "$value" ] || continue
    checked=$((checked + 1))
    case "$bundle" in
      *"$value"*) echo "diagnostics: the bundle contains the secret in $(basename "$f")" >&2; exit 1 ;;
    esac
  done
  [ "$checked" -gt 0 ] || { echo "diagnostics: no secrets to check" >&2; exit 1; }
  echo "diagnostics: $checked secrets checked, none in the bundle"
'
