#!/usr/bin/env bash
# AD-2 against the running e2e stack (ADR 0084): back it up, destroy it, including its secrets
# volume, install afresh, and restore. The restored instance must have its old secrets and its
# old data: the compat key still works, a cap still refuses, and the admin's session, signed
# with the restored auth secret, is still valid. Uses test/compat/.state.json from
# `pnpm test:compat`. No secret is printed: secrets are compared by digest, in variables.
#
# Then NF-S9 (ADR 0115): back up, rotate the credential key, retire the old one, and check the
# compat key still works, which decrypts the provider key; then restore the backup from before
# the rotation and check it works with its own key files, and only those.
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_FILE="compose.yaml:docker/compose.e2e.yaml"
state=test/compat/.state.json
base=$(node -p "require('./$state').baseUrl")
key=$(node -p "require('./$state').key")
poor=$(node -p "require('./$state').poorKey")
cookie=$(node -p "require('./$state').adminCookie")
ok_model=$(node -p "require('./$state').models.ok")

digest() { docker compose exec -T api sh -c "sha256sum /run/lakka/secrets/$1 | cut -d' ' -f1"; }
count() { docker compose exec -T postgres psql -U lakka -d lakka -Atc "$1"; }
chat() {
  curl -s -o /dev/null -w '%{http_code}' "$base/v1/chat/completions" \
    -H "authorization: Bearer $1" -H 'content-type: application/json' \
    -d "{\"model\":\"$ok_model\",\"max_tokens\":20,\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}"
}

echo "backup-restore: backing up the running stack"
name=$(docker compose run --rm -T backup | tail -n 1)
file="backups/$name"
test -f "$file"
# Readable by its owner only.
test "$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")" = 600
# Listed once, not piped into grep -q: it stops reading at its match, and under pipefail tar's
# failed write then fails the script.
listing=$(tar -tzf "$file")
grep -qx 'lakka-backup/database.dump' <<< "$listing"
grep -qx 'lakka-backup/secrets/credential_master_key' <<< "$listing"
key_digest=$(digest credential_master_key)
auth_digest=$(digest auth_secret)
people=$(count 'select count(*) from principals')
usage=$(count 'select count(*) from usage')

echo "backup-restore: a restore refuses while the api is running"
if docker compose run --rm -T backup restore "$name" 2> test-results/restore-refused.err; then
  echo "backup-restore: restore ran with the api up" >&2
  exit 1
fi
grep -q 'connections are still open' test-results/restore-refused.err

echo "backup-restore: destroying the stack, secrets included, and installing afresh"
docker compose down -v --remove-orphans
docker compose up -d --wait
test "$(digest credential_master_key)" != "$key_digest"
test "$(count 'select count(*) from principals')" = 0

echo "backup-restore: restoring"
docker compose stop api worker web valkey
docker compose run --rm -T backup restore "$name"
docker compose up -d --wait

test "$(digest credential_master_key)" = "$key_digest"
test "$(digest auth_secret)" = "$auth_digest"
test "$(count 'select count(*) from principals')" = "$people"
test "$(count 'select count(*) from usage')" -ge "$usage"
curl -fsS "$base/healthz" > /dev/null
test "$(chat "$key")" = 200
test "$(chat "$poor")" = 402
test "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/me" -H "cookie: $cookie")" = 200
rm -f "$file"
echo "backup-restore: restored instance has its secrets, data, keys, caps and sessions"

key_files() { docker compose exec -T api sh -c 'cd /run/lakka/secrets && ls credential_master_key*' | tr '\n' ' '; }

echo "backup-restore: backing up, then rotating the credential key"
before_rotation=$(docker compose run --rm -T backup | tail -n 1)
docker compose stop api worker
docker compose run --rm -T credential-key rotate > test-results/rotate.out
docker compose up -d --wait
test "$(key_files)" = "credential_master_key credential_master_key_v2 "
new_key=$(docker compose exec -T api cat /run/lakka/secrets/credential_master_key_v2)
# The command never shows a key: `run` output reaches the logging driver.
if grep -qF "$new_key" test-results/rotate.out; then
  echo "backup-restore: rotate printed the key" >&2
  exit 1
fi
# The recovery key is the new one, read with exec.
test "$(docker compose exec -T api lakka recovery-key)" = "$new_key"
test "$(chat "$key")" = 200

echo "backup-restore: retiring the old key"
docker compose stop api worker
docker compose run --rm -T credential-key retire
docker compose up -d --wait
test "$(key_files)" = "credential_master_key_v2 "
test "$(chat "$key")" = 200
test "$(chat "$poor")" = 402
docker compose run --rm -T credential-key status | grep -E '^v1 +retired' > /dev/null

echo "backup-restore: restoring the backup from before the rotation"
docker compose stop api worker web valkey
docker compose run --rm -T backup restore "$before_rotation"
docker compose up -d --wait
test "$(key_files)" = "credential_master_key "
test "$(digest credential_master_key)" = "$key_digest"
test "$(chat "$key")" = 200
test "$(docker compose exec -T api lakka recovery-key | tr -d '\n' | sha256sum | cut -d' ' -f1)" = "$key_digest"
rm -f "backups/$before_rotation"
echo "backup-restore: rotated, retired, and restored to before the rotation with its own key"
