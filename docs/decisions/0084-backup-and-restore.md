# 0084. Backup and restore

Status: accepted; extended by ADR 0115 (restore also removes credential key files the backup does not hold).

## Context

- AD-2: a single-command backup and restore that covers the database and the secrets.
- ADR 0075 Q4:
  - a `backup` compose service on the Postgres image, so `pg_dump` matches the server;
  - one `.tar.gz` of the dump and the secrets, with restore working the same way while api and worker are stopped;
  - the file unencrypted in v1, readable only by its owner, and documented as holding the master key.
- Invariant 5: Valkey is a cache, rebuilt from Postgres; it is not backed up.
- Roles are cluster-wide in Postgres and not part of a database dump, so a restore onto a fresh install meets a server whose `lakka` role has that install's password.

## Decision

- **The service.** `backup` in `docker/compose.yaml`:
  - It uses the database's own image, through a YAML anchor, so the two cannot drift.
  - It sits in the `tools` profile, so `docker compose up` never starts it.
  - It runs `docker/backup.sh`, mounted read-only, as root, since restore writes the secrets volume.
  - Backups go to `backups/` at the repository root, or `LAKKA_BACKUP_DIR`. The directory is in the repository with a `.gitignore` that ignores its contents, so it exists and belongs to the operator before the first backup.
- **Backup:** `docker compose run --rm backup`.
  - `pg_dump --format=custom` takes one consistent snapshot of the whole database (every schema, pg-boss's included) while the instance keeps serving.
  - The archive holds that dump, a copy of every file in the secrets volume, and a manifest: format, time, Postgres version, migrations applied, and the secret names.
  - It is written under a hidden partial name and renamed when complete, with mode 600, owned by whoever owns the backups directory. The command prints the file name, the only thing on stdout.
- **Restore:** `docker compose stop api worker web valkey && docker compose run --rm backup restore <file> && docker compose up -d --wait`. That is one line, three compose steps. The backup container cannot stop or start other containers, and giving it the Docker socket would give it the host.
  - It refuses, changing nothing, if anything else is connected to the database.
  - It restores into a new database first, and swaps it in only once that succeeded. A failed restore leaves the current database as it was.
  - It then writes the backup's secrets as `init` does (mode 444) and derives `valkey.conf` from the restored cache password, as `init` does.
  - It sets the running server's role password to the restored database password, which the api will now connect with.
  - `up` restarts Valkey with the restored password. The worker rebuilds the budget counters from Postgres at start (ADR 0052), so nothing in Valkey needs restoring.
- **Encryption.** The archive is not encrypted (Q4). The README and the guide say it holds every secret, including the credential master key, and that anyone who has it has the instance.
- **Release.** Compose mounts the script from the repository. The release pipeline ships `docker/backup.sh` alongside the compose file.

## Consequences

- A restore of an older backup onto a newer release is migrated forward when the api starts (AD-4). A backup from a newer release is refused by an older api, like any unknown migration.
- The stack job backs up the e2e stack, checks that a restore refuses while the api runs, destroys the stack with its volumes, installs afresh, and restores. It then checks that:
  - the master key and auth secret are the old ones;
  - people and usage are back;
  - the compat key still answers, and its capped twin is still refused;
  - the admin's session is still valid.
- Backups contain deleted people's data until they are replaced (ADR 0082). The documentation says so.
- `psql` receives the restored database password as a variable on its command line, visible only inside the short-lived backup container.
