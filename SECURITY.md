# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue, pull request or discussion for a
vulnerability.

Include what you can of:

- the version (the `VERSION` file of a release bundle, or the diagnostics bundle's `manifest.json`);
- what an attacker can do, and what they need first (an account, a key, a network position);
- steps to reproduce, or a proof of concept;
- whether it is already public.

The diagnostics bundle (`docker compose exec -T api lakka diagnostics > bundle.tar.gz`) holds
no credentials, prompts, names or emails, and is safe to attach.

## What happens next

- We aim to acknowledge a report within 5 working days, and to tell you whether we accept it
  within 10.
- We fix accepted issues in the latest release line, and publish a GitHub security advisory
  with the fixed version, crediting you unless you ask us not to.
- We ask that you give us 90 days from your report, or until a fix is released if that is
  sooner, before disclosing it.

## Supported versions

Security fixes go into the latest minor release. Upgrade to it to receive them; the upgrade path
from the previous minor release is tested on every change.

## What we do

- Dependencies and both container images are scanned with Trivy on every change. A high or
  critical vulnerability with a fix available fails the build.
- Release images are signed with Sigstore (keyless, through GitHub's OIDC). Verify one with:

  ```
  cosign verify ghcr.io/lakka-ai/lakka@sha256:<digest> \
    --certificate-identity-regexp '^https://github.com/lakka-ai/lakka/\.github/workflows/release\.yml@refs/tags/v' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

## Tool servers and the sandbox

Tool servers added as a command (stdio MCP servers) run in the `sandbox` service, never in the api
(NF-S4, ADR 0118). Only instance admins can add one. Each test, sync and tool call starts the
command afresh under a user id of its own, with limits on processes, memory, CPU time and files,
and ends everything it started afterwards. It cannot read Lakka's secrets or keys, or reach
Postgres, Valkey or the api. Its only way out is the `egress` proxy, with a token the api makes
for that one call: only to the origins an instance admin listed, and never to Lakka's own
services.

What this does not cover:

- **Docker Engine older than 26.** Older engines let a container on an internal network look up
  outside names, so a server could resolve names it should not. Lakka needs 26 or later.
- **Rootless Docker and userns-remap.** The calls run as user ids 61000 and up, which the
  container's mapped range must include; the default 65,536 does. If it does not, the sandbox
  never starts and command-line tool servers are unreachable. Nothing falls back to running them
  elsewhere.
- **What a server is given.** A server receives its tool calls' arguments and, if it has one, its
  credential, and may send them to any origin on the instance's list, including origins listed
  for other servers. Keep the list to what your servers need.
- **Tool servers reached over HTTP.** The origin allowlist covers what Lakka sends them (ADR
  0117). What such a server does after Lakka calls it is up to that server and whoever runs
  it.

## The price feed signing keys

Price updates (off unless an instance admin turns them on) are checked against Ed25519 public keys
built into each release (ADR 0116). The project owner holds the private keys, a primary and a
backup, offline in a password manager; nobody else can sign a price list. If either private key
is lost to someone else, or suspected to be:

1. We stop signing with it and publish a GitHub security advisory saying which key id, from when,
   and which releases trust it.
2. We ship a release that no longer trusts that key, and sign the next price list with the other
   key. Turn price updates off, or set `LAKKA_CATALOGUE_FEED_URL=off`, until you have upgraded.
3. Every release from then on refuses a feed signed with the removed key, and one already stored
   is ignored, so it can neither set prices nor hold back the honest feeds after it.

Even a validly signed list cannot make a model free, cut a price below a quarter of the release's
price, remove a model or override a model an admin added.
