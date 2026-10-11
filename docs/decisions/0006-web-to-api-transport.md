# 0006. How web calls api: same origin, cookies, CSRF

Status: accepted

## Context

`web` must talk to `api` over HTTP only. The docs do not settle the base URL, how auth travels, or CSRF protection.

## Decision

- Web and api share one origin. Caddy sends `/api/*`, `/v1/*` and `/healthz` to api and everything else to web, without rewriting paths; api registers those prefixes itself.
- The browser uses relative URLs and session cookies (`HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS). No CORS.
- During SSR, web calls `LAKKA_API_INTERNAL_URL` (default `http://api:3000`) and forwards only the `Cookie` header and the request id.
- CSRF: Better Auth's origin check, plus an api-wide check of `Origin`/`Sec-Fetch-Site` on unsafe methods for cookie-authenticated requests. Requests with a bearer key carry no ambient credentials and are exempt.
- One TanStack Query client per request, so one user's data can never render into another user's HTML.
- In development, the Vite dev server forwards the same prefixes to the api, which mirrors Caddy.
- Enforcement: oxlint and the boundary test forbid web from importing core, db, pg, the cache client or pino.

## Consequences

- No CORS configuration anywhere.
- Web and api must always sit behind the same origin, which Caddy guarantees. A customer's own reverse proxy must keep them together; this ties into NF-C4 (subpath deployment), which needs its own spike.
