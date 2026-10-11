# 0033. Web admin shell

Status: accepted; its build-time source link is replaced by ADR 0085, which reads it at runtime.

## Context

M1 needs an admin shell: sign-in, workspaces, members, keys, people and sign-in providers. NF-A1 requires WCAG 2.1 AA, NF-A2 requires UI strings outside the code, and AD-6 requires the AGPL source notice for network users. The stack names TanStack Start and HeroUI. The acceptance suite needs accounts before first-run setup exists.

## Decision

- **Data flow:** the web app reaches the api only over HTTP (ADR 0006), through one client (`apps/web/src/lib/api.ts`).
  - In the browser, requests are relative and carry the session cookie.
  - During SSR, requests go to `LAKKA_API_INTERNAL_URL` and forward only the incoming `Cookie`.
  - TanStack Query holds server state, with one `QueryClient` per router, and so per request, so one person's data never renders into another's page.
  - The authenticated layout loads `/api/me` before rendering and sends visitors without a session to `/sign-in`.
- **Permissions stay in the api.** The UI hides actions a role cannot take, only as a convenience; the api decides.
- **Strings** live in `apps/web/src/i18n/en.ts`, looked up with a typed `t(key, params)`. A unit test keeps the copy ASCII-only.
- **Contrast:** HeroUI 3.2's default accent, muted and danger colors miss 4.5:1 for normal text, so `app.css` darkens those three tokens.
- **The AGPL notice** is in every page footer, linking to the source. The URL is `VITE_LAKKA_SOURCE_URL` at build time and defaults to the project repository, so anyone who ships a modified build can point it at their own source.
- **Operator command `lakka create-user`** creates a local account, optionally as an instance admin. It reads the password from stdin, so it never appears in shell history or the process list, and prints only the principal id. It is for recovery, when nobody can sign in, and for the acceptance suite. Running it needs access to the host's Docker, which already implies full control of the instance. First-run setup in the browser remains the normal way to create the first admin (AD-1, ADR 0034).
- **Acceptance suite:** Playwright against the running compose stack, the way a customer runs it (`pnpm test:e2e`).
  - Global setup creates accounts with the operator command and signs each in once, saving the browser session. Tests reuse those sessions, because sign-in throttling (3 per address per 10 seconds) must not be weakened for tests, and Caddy sets the client address, so it cannot be spoofed.
  - Every test fails on any console or page error, which catches hydration mismatches. Every page is checked with axe for serious or critical WCAG 2.1 A/AA violations, after animations settle. One test signs in with the keyboard alone.
  - CI runs the suite on amd64 and arm64.
- **Subpath deployment (NF-C4) is not handled yet.** Every URL the app builds is relative, so adding a base path later is a configuration change, not a rewrite.

## Consequences

- The shell is plain but accessible. Visual polish can come later without touching data flow or permissions.
- Adding a UI string means adding a key to `en.ts`. A second language adds a file with the same keys.
- The e2e suite needs a running stack and a browser download, so it runs in the `stack` CI job and not in unit tests.
- Keeping `create-user` is a deliberate recovery path. It stays behind host access and never over HTTP.
