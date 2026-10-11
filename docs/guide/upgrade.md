# Upgrade

Upgrades are in place: the same volumes, a newer version. The database is upgraded automatically
when the new api starts, and the api refuses to start on a database newer than itself. Upgrading
from the previous release is tested on every change.

Upgrades are forward only. The way back is the backup you take first.

## From a release bundle

1. Read the release notes on the GitHub release for anything to do before or after.
2. Back up:

   ```
   docker compose run --rm backup
   ```

3. Download and verify the new bundle (see [Install](install.md#verify-the-download)).
4. Unpack it over the current directory. Your `.env` file and `backups/` are kept; the compose
   files, `backup.sh` and `VERSION` are replaced:

   ```
   tar -xzf lakka-v1.3.0.tar.gz --strip-components=1
   ```

5. Start the new version. Compose pulls the new images, pinned by digest, and replaces the
   containers:

   ```
   docker compose up -d --wait
   ```

6. Check it: **Source code** in the account menu links to the version's source, `/healthz`
   answers, and `cat VERSION` names the new release.

Stopping the old containers lets requests in flight finish for up to 20 seconds, so step 5 can
take half a minute.

## From a source checkout

```
docker compose run --rm backup
git fetch --tags && git checkout v1.3.0
docker compose up -d --build --wait
```

## Upgrading to the tool server allowlist

The version that brings in the list of allowed tool server origins (see
[Administration](administration.md#allowed-tool-server-origins)) keeps your tool servers working:

- The upgrade allows the origin of every tool server reached over HTTP, shown on **Admin**, **Tool
  servers** as added by the upgrade. An address whose host is not plain ASCII is left out: allow
  its origin by hand.
- For a server that signs people in with their own accounts, the origins of its sign-in service
  are allowed the first time someone uses it after the upgrade. After that, a removed origin stays
  removed. Changing such a server's address or how it signs in ends this.
- Lakka no longer follows redirects for any tool server, an instance admin's included. A server
  whose address redirects, such as `http` to `https`, fails until its address is changed to where
  it redirects; allow that origin first.

## Upgrading to the sandbox

The version that runs command-line tool servers in a sandbox (see
[Administration](administration.md#command-line-servers)) adds two services, `sandbox` and
`egress`, which start with the rest, and the volumes for their keys and socket, which the first
start makes: nothing to do to start them. It needs Docker Engine 26 or later (see
[Install](install.md#what-you-need)). A tool server reached over HTTP is not affected.

- **A command-line server has no network** until the origins it calls are allowed on **Admin**,
  **Tool servers**, and it reaches them through the proxy settings it is given; one that ignores
  them stays without network. Test each command-line server after upgrading.
- **Its files move.** A command, or files it needs, mounted into the `api` service in a compose
  override must now be mounted into `sandbox` instead, readable by any user. The same holds for an
  image you built on Lakka's to add a command: the `sandbox` service runs the app image too.
- **It cannot write outside a temporary home**, which is emptied after every call, and cannot read
  the secrets volume. A server that kept files between calls, or read a secret file, needs another
  way.

## Upgrading to the rate limit

The version that brings in the per-person rate limit on model requests (see
[Administration](administration.md#rate-limit)) turns it on at 120 requests a minute, and 60 at
once. A person who starts more is refused with `rate_limited` until the limit allows again. Before
upgrading, look at integrations that run on one person's key, such as Open WebUI shared by a team:
they now share that person's limit. Give such an integration an account and a key of its own (see
[The API](api.md#errors)), or change the limit for everyone with
`LAKKA_MODEL_REQUESTS_PER_MINUTE` and `LAKKA_MODEL_REQUEST_BURST` (see
[Configuration](configuration.md#rate-limit)). While Valkey cannot be reached, every model request
is now refused, whether or not a budget applies, unless the limit is turned off.

## If something goes wrong

- The api refuses to start and its log names a migration: the database could not be upgraded.
  Collect a diagnostics bundle (see [Troubleshooting](troubleshooting.md)), then go back.
- To go back, run the previous version and restore the backup you took before upgrading (see
  [Backup and restore](backup-and-restore.md)). Starting the previous version on the upgraded
  database without restoring is refused, by design.
