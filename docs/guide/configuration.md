# Configuration

Nothing needs configuring for a default install. Every setting has a working default, and the
compose files are never edited. To change a setting, put it in a `.env` file next to
`compose.yaml` and run `docker compose up -d` again:

```
LAKKA_DOMAIN=ai.example.com
LAKKA_LOG_LEVEL=debug
```

An empty value counts as unset. Compose reads `.env` itself: some settings decide what compose
does, such as which ports it publishes, and the rest it passes on to the app. It passes on only
the settings on this page up to [Secrets](#secrets); the others are read by the app but must be
given to its containers another way (see
[Settings compose does not pass on](#settings-compose-does-not-pass-on)).

A setting the app cannot accept stops it from starting, and its log names the setting, never its
value: `invalid configuration: LAKKA_PUBLIC_URL`.

## Address and HTTPS

| Setting            | Read by          | Default                                                             | Meaning                                                                                                                                                                                                                               |
| ------------------ | ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAKKA_DOMAIN`     | compose, the app | unset                                                               | The host name people use. Set, Caddy obtains a certificate for it and serves HTTPS. See [Install](install.md#serve-it-on-a-domain-with-https).                                                                                        |
| `LAKKA_HTTP_BIND`  | compose          | `127.0.0.1`                                                         | The address the HTTP port listens on. `0.0.0.0` for every interface.                                                                                                                                                                  |
| `LAKKA_HTTP_PORT`  | compose, the app | `8080`                                                              | The published HTTP port.                                                                                                                                                                                                              |
| `LAKKA_HTTPS_BIND` | compose          | `127.0.0.1`                                                         | The address the HTTPS port listens on.                                                                                                                                                                                                |
| `LAKKA_HTTPS_PORT` | compose          | `8443`                                                              | The published HTTPS port.                                                                                                                                                                                                             |
| `LAKKA_PUBLIC_URL` | the app          | `https://<LAKKA_DOMAIN>`, else `http://localhost:<LAKKA_HTTP_PORT>` | Set only if people reach Lakka at another address, such as through your own proxy. An origin only, with no path: Lakka is served at the root of its address. Sign-in, identity provider callbacks and MCP account connections use it. |

## Integrations

| Setting                      | Default                                       | Meaning                                                                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAKKA_OIDC_PRIVATE_ORIGINS` | unset                                         | Comma-separated origins of identity providers on a private network, such as `https://keycloak.corp.internal`. Providers at private or loopback addresses are refused unless listed. Each entry must be an origin only, with no path.                                                              |
| `LAKKA_MCP_PRIVATE_ORIGINS`  | unset                                         | Comma-separated origins of MCP servers on a private network that **workspace** admins may add. They count as allowed tool server origins too. Instance admins' servers need no entry here, only an allowed origin (**Admin**, **Tool servers**). Each entry must be an origin only, with no path. |
| `LAKKA_OTLP_ENDPOINT`        | unset                                         | Also send traces to your own OpenTelemetry collector, over OTLP/HTTP, such as `https://otel.example.com/v1/traces`. An `http` or `https` URL. Unset, nothing is sent. See [Operations](operations.md#sending-traces-to-your-own-backend).                                                         |
| `LAKKA_OTLP_HEADERS`         | unset                                         | Headers for that endpoint, `name=value` pairs separated by commas. Or put them in the `otlp_headers` secret file.                                                                                                                                                                                 |
| `LAKKA_SOURCE_URL`           | the project repository at the running version | Where the AGPL notice links to: an `http` or `https` URL. Set it if you run changed code; see [Licence and source](license.md).                                                                                                                                                                   |
| `LAKKA_CATALOGUE_FEED_URL`   | the project's own price list on GitHub        | Where price updates come from once an instance admin turns them on: an `https` URL, such as your own mirror (the signature, not the host, is trusted). `off` hides the switch and keeps updates off. See [Administration](administration.md#price-updates).                                       |

All of these are read by the app.

## Running

| Setting                    | Read by | Default                           | Meaning                                                                                                         |
| -------------------------- | ------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `LAKKA_LOG_LEVEL`          | the app | `info`                            | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`.                                                 |
| `LAKKA_BACKUP_DIR`         | compose | `backups/` next to `compose.yaml` | Where `docker compose run --rm backup` writes and restore reads. An absolute path.                              |
| `LAKKA_CLASSIFIER_THREADS` | the app | `1`                               | CPU threads for each routing classification, 1 to 64. One is enough on the reference hardware. Read by the api. |

## Sandbox

Tool servers added as a command run in the `sandbox` service, which reaches the network only
through the `egress` proxy (see [Administration](administration.md#command-line-servers)).

| Setting                | Read by | Default | Meaning                                                                                                                                   |
| ---------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `LAKKA_SANDBOX_SLOTS`  | the app | `8`     | How many command-line tool calls, tests and syncs run at once, 1 to 64, each under a user of its own. Read by the sandbox.                |
| `LAKKA_SANDBOX_MEMORY` | compose | `2g`    | Memory for all of them together, as Docker writes it, such as `4g`. One call may use at most 1 GiB, so 1 GiB per slot leaves no headroom. |

## Rate limit

Each person may start only so many model requests a minute, on every surface, with their API keys
counting as them. A request past the limit is refused with how long to wait: chat says so, and the
API answers 429 with `Retry-After`. Up to the burst can start at once; after that, requests come
back at the rate per minute.

| Setting                           | Read by | Default | Meaning                                                                                       |
| --------------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------- |
| `LAKKA_MODEL_REQUESTS_PER_MINUTE` | the app | `120`   | Model requests one person may start per minute, on average. A whole number; `0` turns it off. |
| `LAKKA_MODEL_REQUEST_BURST`       | the app | `60`    | How many they may start at once before the rate applies. A whole number, at least 1.          |

Both are read by the api. The limit lives in Valkey, like budgets: while Valkey cannot be reached,
every model request is refused with `budget_unavailable`, whether or not a budget applies. With
the limit turned off, a request no budget applies to does not need Valkey. A limit for one person
is the same everywhere: requests in different workspaces count together.

## Secrets

Generated on the first start into the `secrets` Docker volume, one file each, and never
overwritten afterwards. Back them up with the database (see
[Backup and restore](backup-and-restore.md)): losing the credential key loses every stored
provider key and credential.

| File                                 | What it is                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database_password`                  | The Postgres password.                                                                                                                                                             |
| `cache_password`                     | The Valkey password; `valkey.conf` is derived from it.                                                                                                                             |
| `auth_secret`                        | Signs sessions. Changing it signs everyone out.                                                                                                                                    |
| `credential_master_key`              | Encrypts stored credentials: the recovery key setup showed you.                                                                                                                    |
| `credential_master_key_v2`, `_v3`... | The recovery key after a [rotation](backup-and-restore.md#rotating-the-recovery-key). Once the old key is retired, `credential_master_key` is gone, and it is not generated again. |
| `setup_code`                         | Lets whoever runs the server finish first-run setup. Useless afterwards.                                                                                                           |
| `otlp_headers`                       | Optional, and not generated: headers for `LAKKA_OTLP_ENDPOINT`.                                                                                                                    |

The secrets volume is readable only by the services that need it. Compose gives the containers
no secret through their environment, so in a compose install these files are the only source.

Two more keys live in volumes of their own, and only the services that use them mount them: the
tool host's token in `sandbox-keys` (the api and the sandbox) and the egress proxy's signing key in
`egress-keys` (the api and the proxy). Nothing is encrypted with them, so they are not backed up:
the first start after one is lost makes a new one. The api and the sandbox also share `tool-host`,
a volume in memory that holds only the socket the api calls the sandbox on.

## Settings compose does not pass on

The app reads these, but compose does not give them to its containers, so a line in `.env` has
no effect. To set one, add a `compose.override.yaml` next to `compose.yaml`; compose merges it
in, and the compose files stay unedited. A different classifier model also needs its files
mounted into the api container:

```yaml
services:
  api:
    volumes:
      - /srv/lakka/my-model:/models/my-model:ro
    environment:
      LAKKA_CLASSIFIER_MODEL_DIR: /models/my-model
```

The larger classifier the image carries needs no volume, only its directory and two classifier
threads (see [Administration](administration.md#a-larger-classifier)):

```yaml
services:
  api:
    environment:
      LAKKA_CLASSIFIER_MODEL_DIR: /app/models/paraphrase-multilingual-mpnet-base-v2
      LAKKA_CLASSIFIER_THREADS: '2'
```

| Setting                      | Default                        | Meaning                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAKKA_CLASSIFIER_MODEL_DIR` | the bundled multilingual model | The larger bundled model, `/app/models/paraphrase-multilingual-mpnet-base-v2`, or another ONNX embedding model, with its `tokenizer.json` and, if it has one, `sentence_bert_config.json`. The default thresholds suit both bundled models; re-tune them for another (see [Administration](administration.md#routing)). Routes recompile themselves with the new model. Read by the api. |
| `LAKKA_TOOL_HOST_URL`        | the sandbox's socket           | Where the api sends command-line tool servers' calls, and where the sandbox listens: `unix:/path`, or `http://host:port`. `in-process` runs them inside the api, with its network and its secrets, for development only; the image refuses it. Read by the api and the sandbox.                                                                                                          |
| `LAKKA_EGRESS_PROXY_URL`     | `http://egress:3128`           | The egress proxy, as the sandbox reaches it. Read by the api.                                                                                                                                                                                                                                                                                                                            |

Each secret can also be given as a variable, which wins over its file: `LAKKA_DATABASE_PASSWORD`,
`LAKKA_CACHE_PASSWORD`, `LAKKA_AUTH_SECRET` (32 characters or more),
`LAKKA_CREDENTIAL_KEY` (43 characters or more: 32 bytes, base64url), `LAKKA_SETUP_CODE`
(16 characters or more) and `LAKKA_OTLP_HEADERS`. `LAKKA_CREDENTIAL_KEY` is the first
recovery key. To give every key version instead, after a rotation, set
`LAKKA_CREDENTIAL_KEYS` to version and key pairs, such as `2:<new key>,1:<old key>`; it then
replaces `LAKKA_CREDENTIAL_KEY` and the key files entirely. In a compose install, only
`LAKKA_OTLP_HEADERS` is passed on; Postgres and Valkey read their passwords from the files
whatever the app is given, so leave the others to the files.

The rest tell the processes where to find each other. The defaults match the compose services,
and Caddy and the health checks expect them, so change them only when running the processes
outside compose:

| Setting                                                   | Default                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| `LAKKA_DATABASE_HOST`, `_PORT`                            | `postgres`, `5432`                                             |
| `LAKKA_DATABASE_USER`, `_NAME`                            | `lakka`, `lakka`                                               |
| `LAKKA_CACHE_HOST`, `_PORT`                               | `valkey`, `6379`                                               |
| `LAKKA_API_HOST`, `_PORT`                                 | `0.0.0.0`, `3000`                                              |
| `LAKKA_WORKER_HEALTH_HOST`, `_PORT`                       | `0.0.0.0`, `3001`                                              |
| `LAKKA_WEB_HOST`, `_PORT`                                 | `0.0.0.0`, `3000`                                              |
| `LAKKA_API_INTERNAL_URL`, where the web app finds the api | `http://127.0.0.1:3000`; compose sets `http://api:3000`        |
| `LAKKA_SECRETS_DIR`, where the secret files are           | unset, so no files are read; compose sets `/run/lakka/secrets` |
| `LAKKA_VERSION`, `LAKKA_REVISION`                         | set when the image is built                                    |

A Postgres other than the bundled one needs pgvector 0.8 or later, or a role that may create the
extension: the first start runs `CREATE EXTENSION IF NOT EXISTS vector`. The `backup` service
backs up only the bundled Postgres.

## Operator commands

Run inside the api container with `docker compose exec api lakka <command>`:

| Command                                                        | What it does                                                                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup-code`                                                   | Prints the first-run setup code. Once setup is complete, it says so instead.                                                                                                                                         |
| `create-user --email <email> --name <name> [--instance-admin]` | Creates a local account, reading its password from stdin. For when nobody can sign in: `echo 'a long password' \| docker compose exec -T api lakka create-user --email you@example.com --name You --instance-admin`. |
| `recovery-key`                                                 | Prints the recovery key in use, for saving after a [rotation](backup-and-restore.md#rotating-the-recovery-key). Only to your terminal, never to the logs.                                                            |
| `diagnostics`                                                  | Writes a diagnostics bundle to stdout (use `exec -T` and redirect it).                                                                                                                                               |
| `migrate [--verify]`                                           | Applies pending database migrations. The api does this itself on start; with `--verify`, it only checks that none are pending.                                                                                       |

Replacing the recovery key has commands of its own, which run in the `credential-key` service
rather than the api, since rotating and retiring need the api and the worker stopped:
`docker compose run --rm credential-key rotate`, `retire` and `status` (see
[Rotating the recovery key](backup-and-restore.md#rotating-the-recovery-key)).
