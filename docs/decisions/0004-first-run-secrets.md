# 0004. First-run secret generation and persistence

Status: accepted

## Context

`docker compose up` must work with no edits (NF-D1, NF-D3), so passwords cannot be fixed in the compose file. The tech spec says missing secrets are generated on first run. PR-2 says the encryption key comes from the environment and is never stored in the database.

## Decision

- A one-shot compose service `init` (same image, `lakka init`) runs before Postgres and Valkey. It writes each missing secret with `crypto.randomBytes(32)` (base64url) to its own file in the named volume `secrets`, and never overwrites an existing file.
- Postgres reads its password through `POSTGRES_PASSWORD_FILE`. Valkey reads a generated `valkey.conf`.
- The volume is mounted read-only, and only into services that need it; `web` does not get it.
- Files are mode 0444, because Postgres, Valkey and the app run as different users. Isolation comes from the volume being private to the stack.
- Secret values are never printed or logged (see ADR 0021). `init` prints only the names of the secrets it created.
- `init` generates `database_password` and `cache_password`, and the auth secret and the credential master key the same way.
- An env var with the same name still takes precedence (ADR 0003).

## Consequences

- One extra container, which exits after it runs.
- Secrets survive `docker compose down` but not `down -v`. Backup (AD-2) must include the `secrets` volume, and the docs say so.
- Restoring a database without its secrets volume loses access to stored credentials.
