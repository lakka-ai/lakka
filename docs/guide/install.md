# Install

From nothing to your first model answer in about ten minutes. You need no configuration: every
setting has a working default, and passwords are generated on first start.

## What you need

- A machine with Docker Engine 26 or later and Docker Compose v2.20 or later: Linux (amd64 or
  arm64), or a Mac with Apple silicon or Intel, running Docker Desktop 4.29 or later. Older engines
  let a container on an internal network look up names on the internet, which the sandbox that
  runs command-line tool servers relies on them not doing.
- 2 CPUs and 4 GB of memory for a team of about ten people, and a few GB of disk for the images,
  the database and backups. Lakka's own two images download as under 1 GB.
- An API key from a model provider (Anthropic, OpenAI, Google, DeepSeek, Moonshot AI, Qwen Cloud,
  Xiaomi MiMo or Z.ai), or an OpenAI-compatible server you run, such as Ollama or vLLM.

The first start needs the internet only to pull the images. After that Lakka starts and runs
with no internet access except to your model providers: the classifier's model is inside the
image.

## Get Lakka

Download the release bundle, `lakka-<version>.tar.gz`, from
[the releases page](https://github.com/lakka-ai/lakka/releases), and unpack it where you
want to run Lakka:

```
tar -xzf lakka-v1.0.0-beta.5.tar.gz && cd lakka-v1.0.0-beta.5
```

The bundle holds the compose files, with every image pinned by digest, the backup script, the
licence and a `VERSION` file.

### Verify the download

Each release is signed. With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
installed, check the file is the one the project's release workflow published:

```
sha256sum -c lakka-v1.0.0-beta.5.tar.gz.sha256
cosign verify-blob lakka-v1.0.0-beta.5.tar.gz \
  --bundle lakka-v1.0.0-beta.5.tar.gz.sigstore.json \
  --certificate-identity 'https://github.com/lakka-ai/lakka/.github/workflows/release.yml@refs/tags/v1.0.0-beta.5' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

`sha256sum` is `shasum -a 256` on a Mac. The images themselves are signed too; see
`SECURITY.md` in the bundle.

### Or from source

`git clone https://github.com/lakka-ai/lakka.git`, check out a release tag, and follow the
same steps: compose builds the images on the first start instead of pulling them, which takes a
few minutes longer.

## Start it

```
docker compose up -d --wait
```

The first start pulls the images, generates passwords into the `secrets` volume, and creates the
database. When the command returns, Lakka is running. It listens on this machine only, at
http://localhost:8080, until you give it a domain (below).

It is nine services. `init` writes any missing secrets and exits, on every start. `docker compose
ps` lists the other eight, each healthy: `postgres` and `valkey`; the `api`, the `worker` and
the `web` app; `caddy` in front of them; and `sandbox` and `egress`, where command-line tool
servers run and reach the network (see
[Administration](administration.md#command-line-servers)). Two more, `backup` and
`credential-key`, run only when you call them.

What Lakka keeps is in Docker volumes, named after the project, such as
`lakka_postgres-data`: the database, the secrets, Valkey's data, Caddy's certificates and the
sandbox's keys. [Backup and restore](backup-and-restore.md) says which of them a backup holds.

## First-run setup

Open http://localhost:8080. You are sent to **Set up Lakka**, three steps:

1. **Setup code.** Enter the code only someone with access to the server can read, and
   **Continue**:

   ```
   docker compose exec api lakka setup-code
   ```

2. **Recovery key.** The key is shown once, and it encrypts every provider key and other
   credential Lakka stores. **Copy** it into your password manager, or **Download as a text
   file**, tick **I have saved the recovery key somewhere safe**, and **Continue**. It is also in
   every backup, but a backup is not a password manager. To replace it later, see
   [Rotating the recovery key](backup-and-restore.md#rotating-the-recovery-key).
3. **Admin account.** Your name, email and a password of at least 12 characters make you the
   instance admin, and the **Workspace name** makes the first workspace, with you as its admin.
   **Create account and workspace** signs you in.

Setup keeps the code and the key only in the page. If you reload it before the last step, start
again at the setup code.

## Your first model answer

1. Open **Models and providers** under **Admin** in the menu, then its **Model providers** tab. On
   your provider's row, **Add key**, paste its API key and **Save and check**. The check lists the
   provider's models with the key, which costs nothing, and the row says **Connected**.
2. Open **Routing** in the menu and choose a **Default model** from your provider under
   **Settings**; **Save**. The models of every provider with its own row are in the bundled
   catalogue with their prices. For an OpenAI-compatible server, first add the model on the **Models** tab (see
   [Administration](administration.md#providers-and-models)).
3. Open **Chat**, write a message and **Send**. Or skip Lakka's chat: create a key under **API
   keys** on the **Workspace settings** page and point any app that speaks the OpenAI API at
   `http://localhost:8080/v1` with the model `auto` (see [The API](api.md)).

Every request is priced from the catalogue before it is sent, so a model with no price cannot be
used. Set a budget before inviting people (see
[Administration](administration.md#budgets-and-spend)).

## Serve it on a domain, with HTTPS

To let other machines reach Lakka, give it a domain. Caddy, in front of the app, then obtains
a certificate from Let's Encrypt and serves HTTPS, so passwords, sessions and keys never cross a
network in the clear.

1. Point a DNS record for the name, such as `ai.example.com`, at the machine.
2. Make ports 80 and 443 reachable from the internet: the certificate authority checks the name
   over them.
3. Create a `.env` file next to `compose.yaml`:

   ```
   LAKKA_DOMAIN=ai.example.com
   LAKKA_HTTP_BIND=0.0.0.0
   LAKKA_HTTP_PORT=80
   LAKKA_HTTPS_BIND=0.0.0.0
   LAKKA_HTTPS_PORT=443
   ```

4. `docker compose up -d --wait`, and open https://ai.example.com.

Once you are sure the name will always be served over HTTPS, you can also tell browsers never to
use plain HTTP for it (HSTS). Lakka does not send that header itself, since it cannot know
whether every address in front of it is HTTPS; if you put your own proxy or load balancer in
front, set it there.

Access over a local network without a public name, with a certificate Lakka makes itself, is
not supported in this version. Serving the default plain-HTTP port on a network address is
possible (`LAKKA_HTTP_BIND=0.0.0.0`) but sends passwords and keys unencrypted: do it only on a
network you trust completely.

## Next

- [Administration](administration.md): people, workspaces, providers, budgets, routing and tools.
- [The API](api.md): connecting the apps, coding harnesses, scripts and SDKs your team already
  uses, such as Open WebUI, instead of or alongside Lakka's chat.
- [Backup and restore](backup-and-restore.md): set up backups before you rely on it.
