# 0115. Rotating the credential master key

Status: accepted. Builds what ADR 0038 deferred; changes ADR 0034 (the recovery key
can be read again after setup) and ADR 0021 (`lakka recovery-key`); extends ADR 0032 (numbered
key versions) and ADR 0084 (restore removes key files the backup does not hold).

## Context

- NF-S1 encrypts stored credentials under one master key from the secrets volume or
  `LAKKA_CREDENTIAL_KEY` (ADR 0032). ADR 0038 kept the `v1:` prefix so that a second key
  version could be added later, and deferred rotation to M7. It was never built, and a new
  requirement, NF-S9, asks for it: the key can be rotated without losing stored credentials or the
  ability to restore older backups.
- Eight columns are encrypted with it: `provider_configs.api_key`, `alert_webhooks.secret`,
  `auth_accounts.id_token`, `mcp_servers.oauth_client`, `mcp_credentials.secret` and
  `refresh_secret`, `mcp_oauth_states.code_verifier` and `sso_providers.oidc_config`.
- The key is shown once at setup as the recovery key (ADR 0021, ADR 0034), and only `init` and
  `backup` write the secrets volume; the app services mount it read-only. A backup holds the
  database and every secret, and a restore copies the backup's secrets over the volume (ADR 0084).
- The instance is one host with an api and a worker. Stopping them for a minute is acceptable for
  an operation an operator runs rarely and deliberately, and it removes every question about a
  process writing with a key that is being replaced.

## Decision

- **Numbered keys; the prefix names the key.** A stored value is `v<N>:<iv>:<ciphertext and
tag>`, and `v<N>` is the key it was encrypted with. Decryption picks the key by that version and
  fails with `credential_key_unavailable`, naming the version, when the process was not given it.
  Writes always use the active version. The original key stays `v1`, so no stored value changes
  on upgrade.
- **Where keys live.** v1 stays in `credential_master_key`; later versions are
  `credential_master_key_v<N>` in the same volume. `LAKKA_CREDENTIAL_KEYS="2:<key>,1:<key>"`
  replaces the files entirely for operators who keep keys in the environment (owner decision D4);
  in that form nothing generates or removes a key, and `rotate` only re-encrypts to the highest
  version listed. `LAKKA_CREDENTIAL_KEY` keeps working as v1.
- **Postgres records versions, never keys.** A `credential_keys` table holds each version with a
  fingerprint (an HMAC-SHA256 of a fixed label under the key), when it was recorded, activated and
  retired (owner decision D2). The active version is the highest activated one. Every process that
  touches credentials configures its keys through one helper after migrations: it refuses to start
  with `credential_key_missing` when the active key was not given, or `credential_key_mismatch`
  when a given key is not the recorded one, naming the version, never the key. The first start
  after this change finds no rows and records v1, but only after a stored value decrypts with it,
  so a wrong key is never recorded as right. A key present but not active is never written with.
- **Every encrypted column registers itself.** The column helper adds `table.column` to a
  registry as the schema loads, and rotation works from that registry, never a hand-kept list. A
  unit test checks it against every column in the schema that encrypts.
- **Offline, one-shot rotation (option A).** `docker compose run --rm credential-key rotate`, a
  `tools` profile service on the app image that runs as root to write the secrets volume, like
  `init`:
  1. Refuses while any other client is connected to the database, as restore does.
  2. Reuses a key file for a version above the active one if a crashed run left one; otherwise
     writes the next version, never a number used before, to a temporary file, syncs it, renames
     it to mode 0444 and syncs the directory. The key is on disk before anything is encrypted with
     it, so a backup taken at any point holds every key its database needs.
  3. In one transaction: locks the active `credential_keys` row, checks connections again,
     re-encrypts every registered column row by row from the raw text, each update matching the
     value it read, and activates the new version. A value that does not decrypt aborts the whole
     transaction with `credential_unreadable`, naming the column and row id.

  A crash at any point is safe to rerun: the transaction either committed or did not, and a key
  file left behind is reused. The command never prints a key, since `docker compose run` output
  reaches the logging driver.

- **Retire only when unused.** `credential-key retire` refuses with `credential_key_in_use` while
  any registered column, or any other text column in the schema, holds a value in the stored
  format under an older version; that catches a value written by a process that kept running with
  the old key. It then marks older versions retired and deletes their key files. `init` never
  creates `credential_master_key` once a numbered key file exists, so a retired v1 does not come
  back as a fresh random key.
- **Backups carry their keys; restore makes the set exact.** A backup already holds every file in
  the secrets volume. Restore now also deletes `credential_master_key*` files the backup does not
  have, so a backup taken before a rotation restores with exactly its own keys and its own
  `credential_keys` rows.
- **Reading the new recovery key (owner decision D1).** `docker compose exec api lakka
recovery-key` prints the active key to the command's own output, which `exec` does not hand to
  the logging driver, as `setup-code` does (ADR 0034). It checks the key against Postgres first.
  This changes ADR 0034's "never shown by the product again": anyone who can run it can already
  read the secrets volume.
- **Diagnostics** list the key versions the process was given and the recorded versions with
  their dates and which is active; never a key or a fingerprint (AD-3).
- **Out of scope.** Better Auth encrypts the OAuth access and refresh tokens in `auth_accounts`
  with the auth secret, not this key; rotating the auth secret is a separate matter.

## Consequences

- An operator can replace a key that may have been exposed, with a few minutes of downtime: back
  up, stop the api and the worker, rotate, start, save the new recovery key, back up again,
  retire.
- Old backups still hold the old key and the values it encrypts, and restore with them. Rotation
  does not help against a database dump that leaked together with its key: whoever has both has
  the credentials, so the provider keys themselves must be rotated at their providers too.
- A process left running through a rotation keeps writing with the old version. Retire refuses
  until those values are gone, so no value is ever left without its key; stopping the process and
  running rotate again re-encrypts them.
- Startup now needs the database before it can configure keys, so the api and the worker read the
  active version after migrations, and a missing or wrong key stops them with a code that names
  the version.
