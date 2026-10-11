# 0034. First-run setup

Status: accepted; widened by ADR 0098 (first-run setup); changed by ADR 0115 (the recovery key can be read again with `lakka recovery-key`).

## Context

AD-1 requires first-run setup in the browser with no files to edit, and NF-D1 requires `docker compose up` to reach that screen with no prior configuration. A fresh instance has no accounts, so the setup screen is public. Whoever reaches it first could otherwise claim the instance, and a host bound to a network address is reachable before its operator gets there. ADR 0021 says the credential master key is shown once on this screen, before setup completes, and never written to logs.

## Decision

- **A setup code proves access to the server.** `init` generates `setup_code` into the secrets volume like the other secrets (ADR 0004); `LAKKA_SETUP_CODE` overrides it (ADR 0003).
  - The operator reads it with `docker compose exec api lakka setup-code`. The command prints it to its own output, never to a log. Once setup is complete it prints nothing and exits non-zero.
  - The setup page shows that command. `init` mentions it when it creates the code. The api logs `setup.pending`, or `setup.code_missing` as a warning, at startup while setup is open.
  - Codes are compared as SHA-256 digests in constant time. Wrong and missing codes get the same answer.
  - Setup requests are throttled to 10 per client address per minute in Valkey. The code has 256 bits, so throttling mainly bounds password hashing.
- **Three steps in the browser:**
  1. Enter the code.
  2. See the credential master key, labelled "recovery key", and confirm it is saved. `POST /api/setup/secrets` returns it only while setup is open and only with the right code, marked no-store.
  3. Create the first admin (a local account) and the first workspace.
- **Setup completes atomically.** One transaction creates the principal as instance admin, the one-row `instance_setup` table entry, the workspace and the membership. That table's primary key can only be `true`, so of two racing setups exactly one commits.
  - The Better Auth user is created just before that transaction, because Better Auth commits on its own. If the transaction fails, the user and its session are deleted, so the same email can be used again.
- **The response signs the new admin in.** Better Auth creates a session on sign-up. Instead of deleting it, the api passes its cookie on, which saves a second password round trip and a sign-in attempt against the throttle.
- **Setup state is explicit, not inferred** from whether an instance admin exists. `lakka create-user --instance-admin` (ADR 0033) does not close setup; closing it takes the setup code in any case, and that code is only readable by someone with the same host access.
- The sign-in page redirects to setup while it is open, and the setup page redirects to sign-in once it is closed.

## Consequences

- An instance cannot be claimed by a stranger who reaches it first, and setup still needs no files.
- After setup, the credential master key is never shown by the product again. Only a backup of the secrets volume (AD-2) recovers it.
- The acceptance suite tests setup in its own Playwright project that runs first. It can pass only on a fresh stack, so CI starts from one and sets `LAKKA_E2E_REQUIRE_FIRST_RUN`; locally it is skipped with a note when the stack was set up before.
