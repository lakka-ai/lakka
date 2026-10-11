# Backup and restore

One command backs up everything Lakka cannot rebuild: the database and the secrets. Valkey
holds only counters and caches that are rebuilt from the database, so it is not backed up.

## What a backup holds

`backups/lakka-backup-<UTC time>.tar.gz`, in the directory you run Lakka from, containing:

- a complete dump of the database: people, workspaces, keys, providers, models, routes, budgets,
  usage, conversations and their files, traces, tool records and settings;
- every secret in the `secrets` volume, including the **credential master key**, the recovery
  key, that decrypts stored provider keys, MCP credentials and identity provider secrets (after a
  [rotation](#rotating-the-recovery-key), every key version the database still needs);
- a small `manifest.json` saying when it was taken, the Postgres version, and how many database
  migrations had been applied.

The sandbox's two keys, in the `sandbox-keys` and `egress-keys` volumes, are not in it. Nothing is
encrypted with them, and the first start after a restore onto a fresh install makes new ones.
Caddy's certificates, in `caddy-data`, are not in it either: with a domain set, Caddy obtains them
again.

The file is **not encrypted**. Anyone who has it has the instance: its data and every stored
credential. It is written readable only by you (mode 600). Keep it wherever you keep the
server's own secrets, and delete old ones you no longer need.

A backup also keeps data you delete later, such as a person you remove (see
[Administration: deleting a person](administration.md#exporting-and-deleting-a-person)), until the
backup itself is deleted.

## Back up

```
docker compose run --rm backup
```

It takes a consistent snapshot while everything keeps running, and prints the file name when
done. A backup that fails never leaves a file that looks complete.

To keep backups somewhere else, set `LAKKA_BACKUP_DIR` to an absolute path in your `.env` file
(see [Configuration](configuration.md)). Run the command from a scheduler, such as cron, for regular
backups; it needs no input.

## Restore

Restoring replaces the database **and** the secrets with the backup's. Stop what writes to the
database first; the restore refuses while anything else is connected:

```
docker compose stop api worker web valkey && docker compose run --rm backup restore lakka-backup-<UTC time>.tar.gz && docker compose up -d --wait
```

- The restore goes into a new database first and replaces the current one only once that
  succeeded, so a failed restore changes nothing.
- It works onto a fresh install too, for example on a new machine: install Lakka (see
  [Install](install.md)), copy the backup into its `backups/` directory, and run the command
  above. The new install's generated secrets are replaced by the backup's.
- People keep their accounts and passwords, keys keep working, and sessions that were valid at
  backup time are valid again.
- Budget counters are rebuilt from the restored database when the stack starts.
- The recovery key files become exactly the backup's, so a backup from before a
  [rotation](#rotating-the-recovery-key) comes back with the key it was taken with.

A backup taken on an older version restores onto a newer one: the database is upgraded when the
api starts. A backup from a newer version is refused by an older one: its api will not start on
the restored database.

## Rotating the recovery key

The recovery key, the credential master key, encrypts every provider key and other credential
Lakka stores. Replace it if it may have been seen by someone who should not have it, or when
someone who knew it leaves. Stored credentials are re-encrypted with the new key; nobody enters
anything again. The api and the worker are down for a minute or two.

1. Back up:

   ```
   docker compose run --rm backup
   ```

2. Stop the api and the worker. Rotation needs the database to itself and refuses while anything
   else is connected:

   ```
   docker compose stop api worker
   ```

3. Rotate:

   ```
   docker compose run --rm credential-key rotate
   ```

   It writes the new key into the `secrets` volume, then re-encrypts every stored credential with
   it in one step. If it is interrupted, run it again: it either finished or changed nothing, and
   it picks up the key it already wrote. It never shows the key, since its output goes to the
   Docker logs.

4. Start again:

   ```
   docker compose up -d --wait
   ```

5. Read the new recovery key and save it in your password manager in place of the old one. It is
   printed to your terminal only, never to the logs:

   ```
   docker compose exec api lakka recovery-key
   ```

6. Back up again, so you have a backup with the new key.
7. Remove the old key. It refuses, and says where, while anything stored still needs it:

   ```
   docker compose stop api worker && docker compose run --rm credential-key retire && docker compose up -d --wait
   ```

`docker compose run --rm credential-key status` lists the key versions, which one is in use, and
whether each key is present, without showing any key.

**Old backups still hold the old key**, and the credentials it opens. That is what lets them
restore: a restore puts back that backup's own keys and nothing else. Delete the old backups you
no longer need.

**Rotation does not undo a leak of the database together with its key**, such as a copied backup
file: whoever has both can read the credentials as they were. Then also replace the provider keys,
MCP credentials and identity provider secrets themselves, at each provider, and enter the new ones
in Lakka.

If you give Lakka its keys in `LAKKA_CREDENTIAL_KEYS` instead of the `secrets` volume (see
[Configuration](configuration.md#secrets)), add the new key to it yourself as the next version
before step 3. Rotate then re-encrypts to it and creates no key, and after step 7 you remove the
old version from the variable.

## Test your backups

A backup you have never restored is a hope. Restore one onto a spare machine now and then, sign
in, and check a key works.
