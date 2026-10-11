#!/usr/bin/env bash
# Backup and restore of the database and the secrets (AD-2, ADR 0075 Q4, ADR 0084). Runs in the
# compose `backup` service, on the same Postgres image as the database, so pg_dump and
# pg_restore always match the server.
#
#   docker compose run --rm backup
#       writes backups/lakka-backup-<UTC time>.tar.gz while everything keeps running
#
#   docker compose stop api worker web valkey \
#     && docker compose run --rm backup restore lakka-backup-<UTC time>.tar.gz \
#     && docker compose up -d --wait
#       replaces the database and the secrets with the backup's; the credential key files
#       become exactly the backup's set, so a backup from before a key rotation restores with
#       the keys its database needs (ADR 0115)
#
# The archive holds the credential master key and every other secret, unencrypted: anyone who
# has it has the instance. It is written readable by its owner only. Nothing here prints a
# secret.
set -euo pipefail

secrets=/run/lakka/secrets
backups=/backups
db="${PGDATABASE:-lakka}"
role="${PGUSER:-lakka}"
export PGHOST="${PGHOST:-postgres}" PGUSER="$role"

say() { printf 'backup: %s\n' "$*" >&2; }
fail() {
  say "$*"
  exit 1
}

# The password Postgres has now, from the secrets volume as it is before any restore.
PGPASSWORD="$(cat "$secrets/database_password")"
export PGPASSWORD

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077

backup() {
  [ -d "$backups" ] || fail "no backups directory is mounted at $backups"
  local stamp name
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  name="lakka-backup-$stamp.tar.gz"
  mkdir -p "$work/lakka-backup/secrets"

  # One consistent snapshot of the whole database, taken while the instance keeps serving.
  pg_dump --format=custom --no-password --dbname="$db" --file="$work/lakka-backup/database.dump"
  local names=()
  for f in "$secrets"/*; do
    [ -f "$f" ] || continue
    cp "$f" "$work/lakka-backup/secrets/"
    names+=("\"$(basename "$f")\"")
  done
  [ "${#names[@]}" -gt 0 ] || fail "no secrets found in $secrets"
  local version migrations
  version="$(psql --no-password --dbname="$db" -Atc 'show server_version')"
  migrations="$(psql --no-password --dbname="$db" -Atc 'select count(*) from drizzle.__drizzle_migrations')"
  cat > "$work/lakka-backup/manifest.json" <<EOF
{
  "format": "lakka.backup",
  "version": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "$db",
  "postgresVersion": "$version",
  "migrationsApplied": $migrations,
  "secrets": [$(IFS=,; echo "${names[*]}")]
}
EOF
  # Written beside the final name and renamed, so a failed backup never looks like a good one.
  tar -C "$work" -czf "$backups/.$name.partial" lakka-backup
  chmod 600 "$backups/.$name.partial"
  # Owned by whoever owns the backups directory, so the operator can read it without root.
  chown "$(stat -c %u:%g "$backups")" "$backups/.$name.partial"
  mv "$backups/.$name.partial" "$backups/$name"
  say "wrote $name ($(du -h "$backups/$name" | cut -f1)). It holds every secret: keep it safe."
  printf '%s\n' "$name"
}

restore() {
  local file="${1:-}"
  [ -n "$file" ] || fail "usage: restore <file in the backups directory>"
  file="$backups/$(basename "$file")"
  [ -f "$file" ] || fail "no such backup: $(basename "$file")"

  tar -C "$work" -xzf "$file"
  local dir="$work/lakka-backup"
  [ -f "$dir/manifest.json" ] && [ -f "$dir/database.dump" ] && [ -d "$dir/secrets" ] \
    || fail "$(basename "$file") is not a Lakka backup"
  grep -q '"format": "lakka.backup"' "$dir/manifest.json" || fail "$(basename "$file") is not a Lakka backup"
  [ -s "$dir/secrets/database_password" ] || fail "the backup has no database password"

  # Anything still connected would write to the database being replaced.
  local others
  others="$(psql --no-password --dbname="$db" -Atc \
    "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()")"
  [ "$others" = 0 ] || fail "$others connections are still open; stop them first: docker compose stop api worker web valkey"

  # Into a new database first, so a restore that fails leaves the current one untouched.
  local staging="${db}_restoring"
  psql --no-password --dbname=postgres -v ON_ERROR_STOP=1 -q \
    -c "drop database if exists \"$staging\"" -c "create database \"$staging\""
  if ! pg_restore --no-password --exit-on-error --single-transaction --dbname="$staging" "$dir/database.dump"; then
    psql --no-password --dbname=postgres -q -c "drop database if exists \"$staging\""
    fail "the database could not be restored; nothing was changed"
  fi
  psql --no-password --dbname=postgres -v ON_ERROR_STOP=1 -q \
    -c "drop database \"$db\" with (force)" \
    -c "alter database \"$staging\" rename to \"$db\""

  # The secrets, as init writes them. valkey.conf follows cache_password, as init derives it.
  for f in "$dir/secrets"/*; do
    local name
    name="$(basename "$f")"
    [ "$name" = valkey.conf ] && continue
    cp "$f" "$secrets/.$name.tmp"
    chmod 444 "$secrets/.$name.tmp"
    mv "$secrets/.$name.tmp" "$secrets/$name"
  done
  # The credential key files become exactly the backup's set, so the keys on disk are the ones
  # the restored database was encrypted with, and a key rotated in after the backup was taken
  # is not left behind (ADR 0115).
  for f in "$secrets"/credential_master_key*; do
    [ -f "$f" ] || continue
    [ -e "$dir/secrets/$(basename "$f")" ] || rm -f "$f"
  done
  printf 'requirepass %s\n' "$(cat "$secrets/cache_password")" > "$secrets/.valkey.conf.tmp"
  chmod 444 "$secrets/.valkey.conf.tmp"
  mv "$secrets/.valkey.conf.tmp" "$secrets/valkey.conf"

  # Roles live outside the database, so the running server still has this install's password:
  # set it to the restored one, which is what the api will now connect with.
  psql --no-password --dbname=postgres -v ON_ERROR_STOP=1 -q \
    -v pw="$(cat "$secrets/database_password")" <<'SQL'
alter role current_user password :'pw';
SQL
  say "restored $(basename "$file"). Start the stack: docker compose up -d --wait"
}

case "${1:-backup}" in
  backup) backup ;;
  restore) restore "${2:-}" ;;
  *) fail "usage: backup | restore <file>" ;;
esac
