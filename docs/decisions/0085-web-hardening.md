# 0085. Web hardening: the page policy and the AGPL source link

Status: accepted; where it puts the AGPL link is changed by ADR 0107.

## Context

- ADR 0075 H6: a strict Content-Security-Policy, with the e2e suite failing on any violation.
- AD-6 and AGPL section 13: network users are offered the source of the version they use.
  - The footer link was fixed at build time (`VITE_LAKKA_SOURCE_URL`). An operator running changed code could not point it at their source without rebuilding.
- TanStack Router 1.170 puts `router.options.ssr.nonce` on every script it writes: Scripts, HeadContent, ScriptOnce and the manifest.
- TanStack Start 1.168 runs request middleware (`createStart({ requestMiddleware })`) before rendering, and passes its context to the router through `getGlobalStartContext()`.
- The Vite dev server injects scripts of its own, without a nonce.

## Decision

- **The page policy.** A request middleware in `apps/web/src/start.ts` makes a fresh 128-bit nonce for every document. It sends:

  ```
  default-src 'self'; script-src 'nonce-<n>' 'strict-dynamic'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none';
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'
  ```

  - Alongside it: `nosniff`, `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy` that turns off the camera, microphone, geolocation, payment and USB.
  - The router takes the nonce from the request context on the server. The document carries it in a `<meta name="lakka-csp-nonce">`, so the browser's router renders the same attributes when it hydrates.

- **Scripts are strict; styles are not.** No `unsafe-inline` and no `unsafe-eval` for scripts. Styles allow inline, because React renders `style` attributes and a style cannot run code.
  - `'strict-dynamic'` lets code that is already running add scripts. What the policy stops is injected markup: inline handlers such as `<img onerror>`, and scripts without the nonce.
- **Production only.** The policy is sent from production builds (`import.meta.env.PROD`). The dev server's own scripts carry no nonce. The e2e suite runs the production image.
- **The api.** Every api response gets `default-src 'none'; frame-ancestors 'none'`, `nosniff` and `Referrer-Policy: no-referrer`, since the api serves data, never pages. A route with a stricter policy of its own, such as attachments (`sandbox`), keeps it.
- **The source link, at runtime.** The root route's loader calls a server function that reads the web container's environment:
  - `LAKKA_SOURCE_URL` if set, and only if it is an http(s) address;
  - otherwise the project repository at `LAKKA_REVISION`, which the release pipeline sets;
  - otherwise the repository itself.
  - Compose passes `LAKKA_SOURCE_URL` to the web service.
- **HSTS is left to the operator's HTTPS setup.** The app cannot tell whether the address in front of it is only ever served over TLS. The guide covers it.

## Consequences

- Every e2e test already fails on a console error, and the browser reports each violation as one. The suite therefore fails on any violation, anywhere, as H6 asks.
  - `test/e2e/security.spec.ts` checks the header, that every script carries the nonce, that each document gets a new one, and that an injected `<img onerror>` is blocked under `script-src-attr` and never runs.
  - It also checks that the footer links to the address the e2e stack configures, which shows the link is read at runtime.
- A future dependency that needs inline script or eval fails the e2e suite, rather than weakening the policy quietly.
- The nonce is readable from the page's own meta tag. A script able to read it is already running, so this gives an attacker nothing the policy was stopping.
