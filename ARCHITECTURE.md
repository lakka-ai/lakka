# Architecture

This document describes how Lakka is built, with milestones M1 to M10 complete. It is a map of
the implementation: which process does what, which function a request passes through, where each
rule is enforced, and where the data lives.

It does not replace the specifications. `docs/tech-spec.md` describes the design and why,
`docs/requirements.md` holds the requirement IDs, and `docs/decisions/` records every decision the
specs leave open. Where a section follows from a decision, the ADR that settled it is named here.
If this document and the code disagree, the code is right and this document needs fixing.

## Contents

1. [The system in one page](#the-system-in-one-page)
2. [Repository layout and boundaries](#repository-layout-and-boundaries)
3. [The request path](#the-request-path)
4. [Identity and authorization](#identity-and-authorization)
5. [The policy snapshot](#the-policy-snapshot)
6. [Routing and the classifier](#routing-and-the-classifier)
7. [Budgets](#budgets)
8. [The provider gateway](#the-provider-gateway)
9. [Models, prices and cost](#models-prices-and-cost)
10. [Conversations and attachments](#conversations-and-attachments)
11. [Tools and MCP](#tools-and-mcp)
12. [Observability](#observability)
13. [Data model](#data-model)
14. [The HTTP surface](#the-http-surface)
15. [The web app](#the-web-app)
16. [The worker and background work](#the-worker-and-background-work)
17. [Configuration and secrets](#configuration-and-secrets)
18. [Deployment](#deployment)
19. [Testing and CI](#testing-and-ci)
20. [Where to find things](#where-to-find-things)

---

## The system in one page

Lakka sits between a team and the model providers they pay for. Every model request, whether it
comes from the web chat or from a program with an API key, goes through one function in
`packages/core`. That function decides who is asking, which model answers, whether the budget has
room, and which tools the model may call as that person. It records what it did.

The three promises the architecture exists to keep:

| Promise                                                | Where it is kept                                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spend cannot exceed a cap                              | A Valkey Lua script reserves the worst-case cost across every cap before dispatch; Postgres records the real spend; anything unreachable means refuse ([Budgets](#budgets)) |
| Every request is attributed and traced                 | One trace per request, one usage row per provider attempt, one audit row per tool call ([Observability](#observability))                                                    |
| A tool can never do what the user is not allowed to do | An API key is a delegation of a person; tools run with that person's own credential after an eight-stage check ([Tools and MCP](#tools-and-mcp))                            |

The surfaces in v1 are web chat and the OpenAI-compatible API. Lakka is an MCP _client_ in v1: it
calls MCP servers as tools. Serving MCP to outside clients is deferred to v2 (ADR 0066); the `mcp`
value exists in the `Surface` type but nothing passes it yet.

### Runtime topology

```
                         browser / OpenAI SDK / Open WebUI / LibreChat
                                          |
                                          v   127.0.0.1:8080 (HTTP), :8443 (HTTPS if LAKKA_DOMAIN)
                               .---------------------.
                               |        caddy        |  TLS, no buffering, no access log
                               '----------.----------'
                 /api /v1 /healthz        |        everything else
              .---------------------------'-------------------------.
              v                                                      v
   .---------------------.      HTTP only, cookie forwarded   .-------------.
   |         api         |<-----------------------------------|     web     |
   |  Fastify adapters   |                                    | TanStack    |
   |  core: pipeline,    |---> model providers                | Start (SSR) |
   |  gateway, budgets,  |---> MCP servers (HTTP)             '-------------'
   |  classifier (ONNX)  |---> OIDC providers, OTLP (opt-in)
   '----.----------.-----'
        |          |                          .-------------.
        |          |                          |   worker    |  pg-boss jobs, budget sweep,
        |          |                          |             |  counter rebuild, alerts,
        |          |                          '--.-------.--'  retention, workspace purge,
        v          v                             |       |       partitions, price feed (opt-in)
   .----------.  .--------.                      |       |
   | postgres |  | valkey |<---------------------+-------'
   | truth    |  | cache  |<---------------------'
   '----------'  '--------'

   api ---- unix socket ----> sandbox   tool host: a runner and a stdio MCP server per
                                 |      operation, each under a uid of its own;
                                 |      internal network, no route out
                                 v
                              egress    proxy: a signed token per operation, listed
                                        origins only, never Lakka's own services
```

Two stateful dependencies only: Postgres (with pgvector) is the source of truth, and Valkey holds
budget counters, rate-limit windows and revocation pub/sub, all of which can be rebuilt from
Postgres (invariants 5 and 11).

### Processes

All Lakka processes run from one image, `lakka/app`, with a subcommand (ADR 0014). Caddy has
its own image. `docker compose up` starts nine services; `backup` and `credential-key` are in the
`tools` profile and run only when asked.

| Compose service  | Command                               | Listens on                      | Role                                                                         |
| ---------------- | ------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `init`           | `lakka init`                          | -                               | One-shot. Generates missing secrets, and the sandbox's keys (ADR 0004, 0118) |
| `postgres`       | `pgvector/pgvector:0.8.6-pg18-trixie` | 5432 (internal)                 | Source of truth, including traces and usage                                  |
| `valkey`         | `valkey/valkey:9.1.2-trixie`          | 6379 (internal)                 | Counters, rate limits, pub/sub (ADR 0009)                                    |
| `api`            | `lakka api`                           | 3000 (internal)                 | Fastify: every HTTP route, the policy pipeline, the classifier               |
| `worker`         | `lakka worker`                        | 3001 (health only)              | Migrations, pg-boss jobs, budget maintenance, partitions                     |
| `web`            | `lakka web`                           | 3000 (internal)                 | TanStack Start SSR served by srvx (ADR 0015); no secrets mounted             |
| `caddy`          | `lakka/caddy`                         | 80, 443 (published on loopback) | Reverse proxy and automatic HTTPS (ADR 0008, 0011)                           |
| `sandbox`        | `lakka tool-host`                     | a unix socket, for the api      | Runs stdio MCP servers, one runner per operation (NF-S4, ADR 0118)           |
| `egress`         | `lakka egress`                        | 3128 (sandbox network)          | The sandbox's only way out: listed origins only (ADR 0118)                   |
| `backup`         | `lakka-backup`                        | -                               | Profile `tools`, never started by `up`; backup and restore (ADR 0084)        |
| `credential-key` | `lakka credential-key`                | -                               | Profile `tools`; rotates the credential master key (ADR 0115)                |

---

## Repository layout and boundaries

```
packages/
  contracts/   zod schemas, shared types, typed errors, OpenAI request types
  db/          Drizzle schema, migrations, migration runner, tenant-scoped queries, encryption
  core/        everything with behaviour: pipeline, gateway, budgets, routing, classifier,
               identity, authorization, tools, MCP, observability, export, diagnostics
apps/
  api/         Fastify: routes that parse input, build a Principal and call core; CLI commands
  worker/      pg-boss and timers that call core
  web/         TanStack Start app; talks to the api over HTTP only
  site/        the project site (VitePress); not part of the product or its image (ADR 0119)
docker/        Dockerfiles, compose files, Caddyfile, entrypoint, backup script
scripts/       CI and release helpers (bundle, scan, compat, upgrade, copy check, DCO check,
               site check, ci:local), the model fetch, and the price catalogue's update, keys
               and signing
test/          cross-package tests: boundaries, integration fixtures, e2e, pattern gallery,
               compat, upgrade, sandbox, site
models/        classifier weights (fetched, not committed; manifest and reference are committed)
feed/          the signed price feed, `catalogue-v1.json` (ADR 0116)
patches/       pnpm patches to dependencies (react-aria, ADR 0103; VitePress, ADR 0120)
docs/          specs, ADRs, gates, the operator guide, the site's landing page, the approved UI
               design
```

The dependency graph points one way:

```
contracts  <---  db  <---  core  <---  api, worker
    ^                                    |
    '--------------  web  ---- HTTP ----'
```

- `core` must not import Fastify, React, `@tanstack/*` or any app. It must not import the hosted
  `ai` package or `@ai-sdk/gateway` either; it uses the provider packages directly (API-3, ADR 0036).
- `db` and `contracts` import nothing above them and no provider SDK.
- `api` and `worker` never import a provider SDK; providers are reached only through `core`.
- `web` never imports `core`, `db`, `pg`, Valkey or pino. It is an HTTP client of the api (ADR 0006).
- `site` imports no workspace package. It reads `docs/index.md` and `docs/guide/` in place and the
  theme file from `docs/design/theme/`. `.dockerignore` keeps it out of the image's build context,
  and an override in `pnpm-workspace.yaml` keeps its Vue out of the product's dependencies
  (ADR 0119).

Two checks enforce this (ADR 0007): `no-restricted-imports` overrides in
[`.oxlintrc.json`](.oxlintrc.json), and [`test/boundaries.test.ts`](test/boundaries.test.ts), which
scans `package.json` dependencies and every static, dynamic and `require` import, including
relative imports that leave their package. The provider-SDK rules live only in the boundaries test.

Toolchain notes:

- api and worker run TypeScript directly with Node 24 type stripping; there is no compile step
  (ADR 0013). This is why `tsconfig.base.json` sets `erasableSyntaxOnly`: no enums, no namespaces,
  no parameter properties.
- `@lakka/core`, `@lakka/db` and `@lakka/contracts` export `./src/index.ts` and ship source.
  The one subpath export is `@lakka/core/runner`, which the tool runner imports instead of all
  of core, since the sandbox starts one for every operation (ADR 0118).
- web is built by Vite into `apps/web/dist` and served by `apps/web/server.ts`.
- Typechecking uses TypeScript 7 (ADR 0012); lint and format use oxlint and oxfmt.

---

## The request path

This is the most important section. Invariant 1 says every request from every surface enters core
through one entry point; here is that path end to end.

### The entry point

[`handleModelRequest(ctx, req)`](packages/core/src/pipeline/handle.ts) takes a `PipelineContext`
and a `ModelRequest` and returns a `ModelResponse`.

```ts
interface ModelRequest {
  requestId: string;
  surface: Surface; // 'chat' | 'api' | 'mcp'
  workspaceId: string;
  principal: Principal; // already authenticated
  request: GatewayRequest; // normalized messages, tools, limits
  model: string | null; // an explicit model, or null to let the workspace decide
  route?: string | null; // a route asked for by name
  conversationId: string | null; // null: stateless, stores no text
  approval?: { approvalId; decision: 'approve' | 'deny'; always: boolean };
  signal?: AbortSignal; // client disconnect
  traceContext?: Context;
}
```

`ModelResponse` carries the routing `resolution`, whether it was an `overridden` sticky decision,
the `routeName`, any budget `fallback`, the `reservedMicroUsd`, and a `stream`.

Core has only one response shape: a `ModelStream`, an async iterable of events (`text`,
`reasoning`, `tool-call`, `tool-activity`, `approval-required`, `finish`) with a `done` promise that
settles only after the budget is settled and the reply is recorded. A non-streaming API response is
the surface collecting that stream (ADR 0057, G8), so budgets and the commitment window behave the
same either way. Streams can be read once.

There is exactly one production caller, `POST /v1/chat/completions` in
[`apps/api/src/openai/routes.ts`](apps/api/src/openai/routes.ts). The web chat is an ordinary client
of that endpoint using its session cookie (ADR 0061, G5). `surface` is `'chat'` for a session and
`'api'` for a bearer key. That is the entire difference between the two surfaces inside core.

### Sequence

```
client
  | POST /v1/chat/completions   (cookie or "Authorization: Bearer lk_...")
  v
api  onRequest    originCheck                      CSRF: Origin / Sec-Fetch-Site
     preHandler   requirePrincipal -> core.authenticate -> Principal
     handler      translateChatRequest              OpenAI JSON -> GatewayRequest
                  workspace = x-lakka-workspace or defaultWorkspaceFor
                  handleModelRequest(pipeline, {...})
core   span "request"
       1  span "policy.authorize"
            authorizeWorkspaceAction(models.use)   role of principal.actingUserId
       2    snapshots.get(workspace)               frozen policy, cached by version
       3  span "policy.rate_limit"  takeModelRequest  one token from the acting person's bucket, or 429
       4  ownConversation                           the acting person's own, or 404
       5  span "policy.resolve_model"  resolveRequestModel -> Resolution
       6  resolveTools                              stage 6: tools this person may use now
       7  signal = client abort | 10 min deadline | revocation
       8  approval continuation, if any             run the paused tool calls first
       9  span "policy.reserve_budget"  reserve     estimate, Lua hold, or cheaper fallback, or refuse
      10  remember or clear the conversation's route
      11  live.track                                so revocation can end it
      12  dispatch                                  gateway: checks, attempts, commitment window
          |  (nothing reaches the client until the first chunk exists)
      13  recordUserTurn                            only now: the request is committed
      14  stream: finishedWith(...) or toolLoop(...)
      15  on end, however it ends:
            span "policy.reconcile"  settle(reservation, sum of usage rows)
            recordReply
api  SSE frames: role chunk, content deltas, tool_calls, tool activity, finish, usage, [DONE]
     x-lakka-* headers: request id, model, routing rule, reason, confidence, route, fallback
```

### Step by step

| #   | Step            | Function                                                                                   | Notes                                                                                          |
| --- | --------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| -   | Authenticate    | `authenticate` in [`core/auth/authenticate.ts`](packages/core/src/auth/authenticate.ts)    | Done by the api before core's entry point; core receives a `Principal`                         |
| 0   | Root span       | `handleModelRequest`                                                                       | Span `request`, kind SERVER; ends when `done` settles                                          |
| 1   | Authorize       | `authorizeWorkspaceAction(ctx, principal, ws, 'models.use')`                               | `NotFoundError` if hidden, `ForbiddenError` if denied; steps 1 and 2 are `policy.authorize`    |
| 2   | Policy snapshot | `PolicySnapshots.get`                                                                      | See [The policy snapshot](#the-policy-snapshot)                                                |
| 3   | Rate limit      | `takeModelRequest` in [`pipeline/rate-limit.ts`](packages/core/src/pipeline/rate-limit.ts) | One token from the acting person's bucket; refusal is `RateLimitedError` (429), BG-12          |
| 4   | Conversation    | `ownConversation`                                                                          | Scoped by workspace and `actingUserId`; gives the sticky decision                              |
| 5   | Resolve model   | `resolveRequestModel` in [`routing/resolve.ts`](packages/core/src/routing/resolve.ts)      | Detects an override of a sticky route                                                          |
| 6   | Tools           | `resolveTools` in [`mcp/tools.ts`](packages/core/src/mcp/tools.ts)                         | Only with a conversation and a tool-capable model; client tools and workspace tools cannot mix |
| 7   | Signals         | `AbortSignal.any`                                                                          | `DEFAULT_MAX_REQUEST_MS` = 10 min, below the 15 min reservation TTL                            |
| 8   | Continuation    | `decideToolApproval`, `runToolCalls`                                                       | Runs before any reservation; may stop again without a model call                               |
| 9   | Reserve         | `reserve` then `reserveBudget`                                                             | Falls back to a cheaper model (BG-7) before refusing                                           |
| 10  | Route memory    | `rememberConversationRoute` / `clearConversationRoute`                                     | After a successful reserve, so a refusal leaves the conversation unchanged                     |
| 11  | Track           | `LiveRequests.track`                                                                       | Revocation aborts with `AccessRevokedError`                                                    |
| 12  | Dispatch        | `dispatch` in [`gateway/dispatch.ts`](packages/core/src/gateway/dispatch.ts)               | Returns only after the first chunk                                                             |
| 13  | User turn       | `recordUserTurn`                                                                           | Failures are logged, never thrown                                                              |
| 14  | Stream          | `finishedWith` or `toolLoop`                                                               | The tool loop reserves and settles per round                                                   |
| 15  | Settle          | `settle`                                                                                   | Sums `usage.cost_micro_usd` for the request's attempts; never throws                           |

`refusedWhenStoresDown` wraps anything thrown here: a connection error from Postgres or the network
(walking the `cause` chain) becomes `BudgetUnavailableError`, a clean 503, rather than a raw 500
(BG-4, ADR 0056). The api applies the same wrapper to authentication errors.

### How a request ends

Every exit path records usage (in `dispatch`) and settles the reservation (in the pipeline):

| Exit                         | Usage row outcome                                | Settled by                                      |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Completes                    | `completed`                                      | `finishedWith` -> `settle`                      |
| Fails before the first chunk | attempts that may have billed, as `abandoned`    | `handle` catch -> `settle`                      |
| Aborted inside the window    | `aborted`                                        | `handle` catch -> `settle`                      |
| Error after the first chunk  | `interrupted` (or `aborted` if the signal fired) | `finishedWith` -> `settle`                      |
| Client stops reading         | `aborted`                                        | `finishedWith` -> `settle`                      |
| Process killed               | none after the kill                              | The worker's sweep, after the reservation's TTL |

A tool loop settles the same way, round by round. Whatever ends the reply, the round in hand is
closed (which records its attempt) and settled before the reply's `done` settles. That holds even
for a round that was never read, because the client left while a continuation's earlier events were
being sent (ADR 0089).

If Postgres is unreachable at settle time, the reservation stays `active` and the sweep settles it
later (ADR 0052).

---

## Identity and authorization

### Principals

A **principal** is a person (`kind = 'user'`) or an API key (`kind = 'key'`). The contracts type:

```ts
interface Principal {
  id: string; // who is asking: the person, or the key
  kind: 'user' | 'key';
  displayName: string;
  actingUserId: string; // the person: themself, or the key's owner
  isInstanceAdmin: boolean; // always false for a key
  workspaceScope: string | null; // a key's one workspace; null for a person
}
```

`actingUserId` is how invariant 2 is kept. Every membership lookup, conversation ownership check,
member budget, MCP credential and tool availability check uses `actingUserId`, so a key always has
exactly its owner's current role and never more. Key-specific things (the key's own cap, standing
approvals being refused for keys) use `id`. The schema backs this up with composite foreign keys onto
`principals (id, kind)`, so a key's owner, a member, a conversation's owner and a credential holder
must all be users.

### Authentication

The api extracts a credential and core resolves it
([`authenticate`](packages/core/src/auth/authenticate.ts)):

- **Session.** `auth.api.getSession` from Better Auth, then the principal by `auth_subject`
  (created on first sight). A principal that is not `active` is refused. Better Auth's cookie cache
  is off, so every request reads the session from Postgres and a revoked session stops at once
  (ID-6).
- **API key.** The secret is `lk_` plus 32 random bytes in base64url. It is stored as a SHA-256
  hex digest, which is safe at that entropy and lets the lookup be by digest. `findKeyForAuth` joins
  the key, its principal, the owner and the owner's membership in the key's workspace. The key is
  refused with one identical message if it is revoked or inactive, its owner is not active, or the
  owner is no longer a member of the key's workspace.

Authenticating also records the person's `principals.last_active_at` (for a key, its owner's), at
most once every five minutes, for the People page (ADR 0097).

A malformed `Authorization` header is refused outright; the request is never retried with its
cookie.

### Better Auth

[`createAuth`](packages/core/src/auth/auth.ts) configures Better Auth with the Drizzle adapter
over our `auth_*` tables and `sso_providers`:

- email and password (12 to 128 characters), OIDC through the SSO plugin, no SAML;
- `uuidv7` ids, cookie prefix `lakka`, secure cookies when the public URL is https;
- its rate limiter stores windows in Valkey through a Lua script, failing closed;
- telemetry off in config, and its telemetry environment variables deleted before it starts;
- its logger drops message text, because Better Auth puts emails in messages (invariant 9);
- a `user.create.before` hook refuses SSO sign-ups the provider's policy does not allow, and a
  `session.create.before` hook refuses sessions for suspended or deleted people.

The api exposes only four Better Auth routes plus the SSO callback (`EXPOSED_AUTH_ROUTES` in
[`auth-routes.ts`](apps/api/src/auth-routes.ts)). Public sign-up is closed; accounts are created by
first-run setup, invites, or the `create-user` command.

### Onboarding

- **First-run setup** ([`setup/service.ts`](packages/core/src/setup/service.ts), ADR 0034): the
  operator reads the setup code with `lakka setup-code`. The browser posts it to reveal the
  credential master key once (ADR 0021), then to create the first instance admin and workspace in
  one call. The code is compared in constant time. Setup closes permanently afterwards
  (`instance_setup` is a single-row table). After a key rotation, `lakka recovery-key` prints
  the active key instead (ADR 0115).
- **Invites** ([`invites/service.ts`](packages/core/src/invites/service.ts), ADR 0035): a 32-byte
  token lives in the URL fragment, so it never reaches a server log, and is stored hashed. An invite
  lasts 7 days. It is a delegation of its creator, like a key: it stops working if the creator is
  suspended or is no longer an admin. Acceptance re-checks under a row lock. A preview names who
  made the link and, for a signed-in person, whether they are already a member (ADR 0098).
- **Password reset links**
  ([`principals/password-reset.ts`](packages/core/src/principals/password-reset.ts), ADR 0098):
  there is no email, so an instance admin makes a one-time link for one person and passes it on.
  The 32-byte token also lives in the fragment and is stored hashed, one per person. It lasts a
  day and is a delegation like an invite: it stops working if its maker is no longer an active
  instance admin. Using it sets the password and ends every session of that person.
- **SSO** ([`sso/service.ts`](packages/core/src/sso/service.ts), ADR 0032): only an instance admin
  with a real session can register an OIDC provider. Each provider has a policy (sign-up allowed,
  allowed email domains). Its display name, policy and client secret can be edited later; its
  issuer and client id cannot, since they decide who a sign-in is (ADR 0097). Identity providers
  on a private network must be listed in `LAKKA_OIDC_PRIVATE_ORIGINS`.

### Authorization

[`decide`](packages/core/src/authz/policy.ts) is a pure function over the principal, the caller's
role in the workspace, the action and an optional target. It returns `allow`, `deny` or `hidden`.
`hidden` becomes a 404, so a non-member cannot learn a workspace exists (AC 16).

| Caller                | Rule                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key                   | `hidden` outside its own workspace or if its owner lost membership; `deny` for anything in `KEY_ACTIONS` (keys, invites, providers, policy, budgets, tools, capture); otherwise as its owner's role |
| Instance admin (user) | `allow` for everything, except `keys.issue` and `models.use` without membership                                                                                                                     |
| Non-member            | `hidden`                                                                                                                                                                                            |
| Workspace admin       | every action except `members.add` (instance admins only)                                                                                                                                            |
| Member                | `workspace.read`, `members.read`, `keys.issue`, `keys.list`, `models.use`, `budgets.read`, plus leaving and revoking their own keys                                                                 |

Services call `authorizeWorkspaceAction`, which loads the workspace and the `actingUserId`'s
membership and applies `decide`. A few rules sit outside it: creating and deleting workspaces,
stdio MCP servers, the MCP origin allowlist, custom models and price updates, SSO, retention,
people administration (password reset links and granting instance admin included) and export are
instance-admin only; invites, MCP OAuth connections and trace reading are people only. Removing
instance admin from the last active one is refused (`last_instance_admin`).

### Revocation

Revoking access takes effect on the next request because nothing is cached. Live requests end too
(AC 6, ADR 0063):

- services emit `principalRevoked` (`suspended`, `deleted`, `key_revoked`, `membership_removed`,
  `workspace_deleted`) on the Valkey channel `lakka:events:principal-revoked`, best effort;
- the api's [`watchRevocations`](packages/core/src/pipeline/live.ts) aborts matching live requests
  on each event and also re-checks every live request against Postgres every 2 seconds, so a lost
  event still ends the stream within seconds;
- suspension and a password reset also delete the person's Better Auth sessions; removing a
  member deletes their MCP credentials in that workspace.

---

## The policy snapshot

[`policySnapshots({ db })`](packages/core/src/routing/snapshot.ts) keeps one frozen
`PolicySnapshot` per workspace in memory. On each `get` it reads `workspaces.policy_version` (a
primary-key lookup) and reloads only when the version changed. `loadPolicyRows` reads everything in
one `repeatable read, read only` transaction:

- routing settings (enabled, default model, pinned model);
- content capture settings;
- routes, their centroids and example embeddings (as `Float32Array`);
- the budgets that apply (the workspace's, and the instance's);
- the enabled tools.

Every write that changes any of these bumps `policy_version` in the same transaction. A change to the
instance budget bumps every workspace. A request therefore routes, bills and offers tools under one
consistent policy even if an admin edits it mid-request (tech spec, stage 3). The api builds one
`policySnapshots` instance and shares it between the pipeline, the MCP routes and the routing routes.

---

## Routing and the classifier

### The resolution order

[`resolveRequestModel`](packages/core/src/routing/resolve.ts) returns the first match (ADR 0046):

| Order | Rule recorded                                                        | When                                                                            |
| ----- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 0     | `explicit`                                                           | The caller asked for `route/<name>`; uses that route's model and fallbacks      |
| 1     | `explicit`                                                           | The caller named a model                                                        |
| 2     | `sticky`                                                             | Routing is on and the conversation already has a decision                       |
| 3     | `pinned`                                                             | The workspace pins a model                                                      |
| -     | `default` (`routing_off`)                                            | Routing is off for the workspace                                                |
| 4     | `signal`                                                             | A deterministic signal claimed by an enabled route: `code_fence` or `code_file` |
| -     | `default` (`no_routes`, `too_short`)                                 | No compiled routes, or fewer than 3 words                                       |
| 5     | `classified`                                                         | The best route's similarity clears its threshold                                |
| -     | `default` (`classifier_unavailable`, `below_threshold`, `ambiguous`) | Otherwise                                                                       |
| 6     | `default`                                                            | The workspace default; `NoModelError` if there is none                          |

The text that is routed on is the latest user message only. The signals are fixed in code, not
configurable ([`signals.ts`](packages/core/src/routing/signals.ts)); each can be claimed by at most
one route.

**Two thresholds.** `directionOf` compares the route's model with the workspace default by
`blendedPrice` (3 parts input to 1 part output). A cheaper target must clear `threshold_down`
(default 0.35); the same or a pricier one must clear `threshold_up` (default 0.30). The schema
requires `threshold_down >= threshold_up` (RT-5). The defaults come from the evaluation set
(ADR 0045, retuned in ADR 0088 and ADR 0123), and are the same for both bundled models. Each
route stores its own.

**One decision per conversation.** The decision is stored on `conversations.routed_model` and
`route_id` only while it is still empty, and reused as `sticky` afterwards (RT-7). A considered "not
sure" is remembered too, as the default model. Choosing a different model in a routed conversation
is an override: the usage row keeps the route that lost and the model chosen, and the conversation's
route is cleared. [`getOverrideSummary`](packages/core/src/routing/overrides.ts) turns those rows
into the per-route suggestions on the routing page (RT-10, ADR 0048). While the workspace records
content, [`listCandidates`](packages/core/src/routing/candidates.ts) offers the message each
overridden conversation was routed on by the classifier as a route example candidate (ADR 0114). It
is derived when read, from `usage`, `messages` and unexpired `span_content`
([`listRouteCandidates`](packages/db/src/queries/routing.ts)), never copied;
`route_candidate_decisions` keeps only what an admin did with one. A route save with
`fromCandidates` writes the examples and the decisions in one transaction, or refuses with
`candidate_gone`.

### Compiling and scoring

- Saving a route calls [`compileWorkspacePolicy`](packages/core/src/routing/compile.ts): embed any
  example not yet embedded with the current model, then store each route's centroid (normalized
  mean) in `route_centroids`.
- **A route's description counts as one of its examples** (RT-12, ADR 0122, ADR 0125). A route
  with a non-empty description has `<name>: <description>` embedded and added to its example
  embeddings with the weight of one example. A route with only a description can therefore be
  chosen from the moment it is saved; one with neither has no centroid and is never chosen.
  [`scoringBasis`](packages/core/src/routing/score.ts) says what a centroid should come from, and
  `route_centroids.source` records what it did come from: `examples`, `description` or
  `examples_and_description`. Changing a route's name or description drops a centroid that used
  it. Thresholds are the route's own whatever the source.
- Scoring ([`scoreRoutes`](packages/core/src/routing/score.ts)) is a dot product in JavaScript over
  the snapshot. pgvector is only storage: there is no vector index and no SQL distance operator.
  The dimension is not fixed in the schema, because every vector records the model that made it.
- If the embedding model changed (its id includes a hash of the weights), stale routes score nothing
  and one background recompile per workspace is started. The request in hand is not held up. A
  centroid whose source is not what the route now calls for (`centroidStale`), such as one made
  before descriptions were blended in, is recompiled the same way but keeps scoring until the new
  one is in.
- `centroid` is the default match mode; `nearest_example` and `calibrated` exist for evaluation.

### The classifier runtime

- [`loadOnnxEmbedder`](packages/core/src/classifier/embedder.ts) dynamically imports
  `onnxruntime-node` and `@huggingface/tokenizers` on first use. It runs the INT8
  `paraphrase-multilingual-MiniLM-L12-v2` model by default (ADR 0088), or the larger
  `paraphrase-multilingual-mpnet-base-v2` (ADR 0123), which the image also carries and an operator
  chooses with `LAKKA_CLASSIFIER_MODEL_DIR`. It runs on the CPU, then mean-pools and
  L2-normalizes to the size the model's output declares: 384 or 768 dimensions. A model that
  declares no fixed size is refused. ONNX Runtime telemetry is disabled in code (ADR 0024).
- [`lazyClassifierRuntime`](packages/core/src/classifier/runtime.ts) shares one load between
  concurrent callers. After a failure it reports `unavailable` for 60 seconds and then retries.
  `cachingEmbedder` keeps an in-memory LRU of 1000 query embeddings, never persisted or logged.
- The weights are baked into the image at build time by `scripts/fetch-models.ts`, which checks
  size and SHA-256 against [`models/manifest.json`](models/manifest.json). Nothing downloads at
  runtime (NF-D5). They are sentence-transformers' own INT8 exports, one file per CPU family: the
  arm64 image gets the arm64 file and the amd64 image the AVX2 one, and each model's directory
  carries its license text and a NOTICE (ADR 0124).
- The classifier is optional (invariant 10). If it cannot load, `/healthz` reports `degraded`, the
  resolution order falls through to the default with `classifier_unavailable`, and everything else
  works.

### Evaluation

`lakka classifier-eval` ([`routing/evaluation.ts`](packages/core/src/routing/evaluation.ts))
runs [`packages/core/eval/routing-v1.json`](packages/core/eval) (7 routes of 40 messages, and 60
"unsure" messages; with German, Spanish, French and Swedish translations) over 20 seeded splits and
reports mean and spread. It uses the production `decideRoute`.

- `--fallback` adds the description scenarios with the three blind description sets in
  `routing-v1.descriptions.json`: each route in turn with only its description, then with 1, 2
  and 4 examples and its description, and every route described at 12 examples. It fails if a
  description ever lowers accuracy or raises misroutes against examples alone (ADR 0122,
  ADR 0125).
- CI gates both models in the image, with no network: 0.80 accuracy in English, and in the other
  languages 0.75 for MiniLM and 0.78 for mpnet, with same-language and English examples
  ([`scripts/classifier-eval-languages.sh`](scripts/classifier-eval-languages.sh)), plus the
  description scenarios in all five languages.

---

## Budgets

The most correctness-sensitive part of the system. The code lives in
[`packages/core/src/budgets/`](packages/core/src/budgets) (ADR 0049 to 0056).

### Caps and scopes

A cap is a row in `budgets` with a scope, a limit in micro-USD, a period (`daily`, `monthly` or
`none`, in UTC) and alert thresholds. [`chargeLines`](packages/core/src/budgets/engine.ts) picks the
caps a request is charged against, outermost first:

| Scope       | Applies when                                                                              |
| ----------- | ----------------------------------------------------------------------------------------- |
| `instance`  | always                                                                                    |
| `workspace` | always, for the request's workspace                                                       |
| `member`    | the cap's person is `principal.actingUserId`, so a key's requests count against its owner |
| `key`       | the request came through that key                                                         |

Instance admins set instance and workspace caps; workspace admins set member and key caps; a key's
owner may cap their own key, but can only lower a cap an admin set. Keys manage no budgets.

### Counters in Valkey

Each cap has one Valkey hash per period, keyed `budget:<budgetId>:<periodStartMs>`:

```
field spent            settled spend in the period
field r:<reservation>  one field per live hold, holding its amount
in use = spent + sum of r:* fields
```

Keeping each hold as its own field makes every step safe to repeat and lets a counter be rebuilt
exactly from Postgres. A counter expires two days after its period ends; a `none` period never
expires. A new period needs no reset: it is a new key, and a new `budget_spend` row.

### Reserve

[`reserveBudget`](packages/core/src/budgets/engine.ts):

1. Insert a `reservations` row (`pending`) and its `reservation_lines`, one per cap, each with its
   period start.
2. Run the `RESERVE` Lua script over every counter. If a counter is missing (new period, or after a
   flush), it returns `missing`; the engine seeds it from Postgres (`SEED`: spend plus active
   holds) and tries again, up to three rounds. Otherwise, for each cap it sums `spent` and every
   hold except its own. If any cap would go over its limit, it returns `denied`, naming the
   innermost cap that refused and the least headroom left anywhere. Otherwise it adds the hold to
   every cap. All or none, on Valkey's single thread.
3. Mark the row `active`. If Postgres fails at this point, release the hold and refuse: a hold with
   no active row could not be rebuilt, and serving the request would be unmetered.

Any Postgres or Valkey error becomes `BudgetUnavailableError` (503). A refusal is
`BudgetExceededError` (HTTP 402, `budget_exceeded`, deliberately not 429 because the SDKs retry
429s; ADR 0057, G2). Amounts stay below 2^53, where Lua's numbers are exact
(`MAX_BUDGET_MICRO_USD`).

### The estimate

[`estimateAttemptCost`](packages/core/src/budgets/estimate.ts) is pessimistic, per BG-2:

```
input  = upper token estimate (text bytes / 2, 5000 per image, max(5000, bytes/25) per PDF,
         a text file as the delimited text the model is given (ADR 0106),
         plus tool definitions and earlier tool calls)
prices = the price tier that input falls in
cost   = ceil((input * max(input price, cache write price) + max_output * output price) / 1e6)
```

`max_output` is the request's `maxOutputTokens`, or the model's maximum. The gateway always sends
that limit to the provider, so output is bounded by the estimate. `estimateRequestCost` takes the
maximum over every failover candidate that has a price. A candidate with no price is dropped; if none
remains, the request is refused (BG-4).

### Fallback to a cheaper model

When the first hold is refused, [`fallBack`](packages/core/src/pipeline/handle.ts) considers the
route's fallbacks and the workspace default, keeps those whose estimate fits the headroom the script
reported, and tries them most capable first (by `blendedPrice`). The first that holds is used, and
only that model may be dispatched. The response reports `{ from, to, scope }`, which the API returns
as `x-lakka-fallback-from` and `x-lakka-fallback-scope` and chat shows in plain language
(BG-7, CH-4, ADR 0053). If nothing fits, the original refusal stands.

### Settle

[`settleReservation`](packages/core/src/budgets/engine.ts) is called with the sum of the request's
usage rows:

1. In one Postgres transaction (`chargeReservation`): claim the reservation only if it is still
   `pending` or `active` (so settling twice never charges twice), add the cost to `budget_spend`
   for each line's own period start, and insert a `budget_alerts` row for every threshold newly
   crossed.
2. Run `RELEASE` in Valkey: for each counter, if the hold is still there, remove it and add the cost
   to `spent`. If the hold is gone, the counter was rebuilt after the charge and already includes it.

Postgres is charged first; a Valkey failure here only leaves a stale hold, which makes caps
stricter until the next rebuild. Actual cost above the reservation is allowed and logged as
`budget.overage`. A reservation is charged to the period it was made in, so a monthly reset during
a request neither loses nor double-counts spend.

### The rate limit

[`takeModelRequest`](packages/core/src/pipeline/rate-limit.ts) keeps one token bucket per person,
instance-wide, keyed `lakka:model-rate:<actingUserId>`, so a key draws on its owner's bucket
(BG-12, ADR 0113). Each call to `handleModelRequest` takes one token, after authorize and the
snapshot and before anything is held or sent; a tool loop's later rounds take none, and an approval
continuation takes one. One Lua script reads Valkey's `TIME`, refills at
`LAKKA_MODEL_REQUESTS_PER_MINUTE` up to `LAKKA_MODEL_REQUEST_BURST`, and takes a token or
returns the wait in milliseconds. The key expires once the bucket would be full again, so a missing
key is a full bucket and there is nothing to rebuild (invariant 5). A refusal is
`RateLimitedError` (429 with `Retry-After`); an unreachable Valkey is `BudgetUnavailableError`
(503), whether or not a cap applies. 0 per minute turns the limit off.

### Maintenance

The worker runs [`startBudgetMaintenance`](packages/core/src/budgets/maintenance.ts) every 30
seconds under a Postgres advisory lock:

- **Sweep.** Reservations past `expires_at` (15 minutes after creation) are charged, marked
  `abandoned`, and released (BG-6, AC 8). The charge is the request's recorded usage less what its
  other settled or abandoned reservations already charged. A tool loop holds one round at a time
  under one request id, so this is exactly the lapsed round's own attempts; the partial unique
  index `reservations_request_live_key` guarantees that no request holds two at once (ADR 0089).
- **Rebuild.** On the first tick and every tenth (every 5 minutes), every counter is rewritten from
  Postgres: `budget_spend` plus the holds of pending and active reservations. Holds newer than a
  60-second cutoff are kept from Valkey, since their rows may not be committed yet. This relies on
  UUIDv7 ids sorting by time. After a Valkey flush the counters come back correct (invariant 5).
- **Alerts.** Pending `budget_alerts` are queued to pg-boss.

### Alerts and spend views

- Each threshold fires once per cap per period (unique on `budget_id, period_start, percent`). The
  pg-boss job `budget-alert` posts a signed JSON payload
  (`lakka-signature: t=<unix>,v1=<HMAC-SHA256>`) to the workspace's webhook, else the
  instance's. It retries up to 8 times with backoff, never follows redirects, and never reads the
  response body. A workspace webhook must be public https and is checked again at connection time
  (ADR 0054). A test alert (`budget.test`) is sent at once from the api when an admin asks, and is
  not queued, retried or kept (ADR 0093).
- [`budgets/spend.ts`](packages/core/src/budgets/spend.ts) builds spend reports from `usage`, by
  day, person (each key on its own row, with its owner), model, workspace, surface and route (by
  how the model was picked). The reports include latency and token percentiles, cheaper-model
  requests and tool usage. Refusals are counted from the root spans, so only as far back as traces
  are kept. Members see only their own spend, their keys' included (ADR 0055, 0093).

---

## The provider gateway

A thin layer over the AI SDK provider packages. It owns what the SDK does not: credentials,
capability checks, error classification, retries and failover, the commitment window, and usage
recording (ADR 0036, 0040).

### Calling a provider

- Core depends on `@ai-sdk/provider`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` and
  `@ai-sdk/openai-compatible`, not on the `ai` package.
  [`streamModelCall`](packages/core/src/gateway/model-call.ts) calls `model.doStream` directly, so
  there are no SDK retries, tool loops, telemetry or URL downloads.
- [`languageModel`](packages/core/src/gateway/providers.ts) builds the adapter: Anthropic, OpenAI
  (Responses API), Google, or an OpenAI-compatible endpoint. API keys and base URLs are always passed
  explicitly and never read from the environment.
- **First-party kinds.** Besides Anthropic, OpenAI and Google, five hosted providers are
  first-party: DeepSeek, Moonshot AI, Qwen Cloud, Xiaomi MiMo and Z.ai
  (`COMPATIBLE_FIRST_PARTY_KINDS` in [`contracts/gateway.ts`](packages/contracts/src/gateway.ts),
  ADR 0126). Each goes through `@ai-sdk/openai-compatible` at a fixed default address, with a key
  required and usage on the stream. Their names are reserved, so an OpenAI-compatible endpoint
  cannot take one, and the Postgres checks on `provider_configs` are built from the same constants.
- Credentials come from `provider_configs`, encrypted at rest.
  [`resolveProviderConnection`](packages/core/src/providers/service.ts) prefers the workspace's own
  credential over the instance's (PR-8). A workspace credential must be one of the eight
  first-party kinds at its standard address; only instance admins may add an OpenAI-compatible
  endpoint, local or online (an SSRF guard, also enforced by a CHECK constraint).

### Dispatch

[`dispatch(ctx, req)`](packages/core/src/gateway/dispatch.ts) takes the candidate list (the model
and its fallbacks) and:

1. **Checks every candidate before sending** (`prepare`): known model, input fits the context
   window, requested output within the model's maximum, vision or PDF or tool support as needed, a
   configured credential. A candidate that fails is skipped and recorded as a span event.
2. **Limits the failover scope.** Fallbacks from another provider are dropped unless the route sets
   `allow_cross_provider` (tech spec, Failover scope). After a budget fallback, only that one model
   is allowed.
3. **Runs attempts through the commitment window**
   ([`commitFirstChunk`](packages/core/src/gateway/commit.ts), ADR 0025). Each attempt gets its own
   abort controller and must produce a first chunk within 30 seconds (180 for reasoning models).
   Nothing is returned to the pipeline, and so nothing reaches the client, until a first chunk
   exists. After that, a failure becomes `StreamInterruptedError` and is never retried (invariant 6).
   A committed stream also has an idle timeout, 60 seconds (180 for reasoning).
4. **Classifies failures** ([`classifyFailure`](packages/core/src/gateway/classify.ts)) and
   decides:

| Failure                                             | Action                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 429                                                 | Retry the same model if `Retry-After` is 10 s or less, else fail over              |
| 5xx, overload, timeout, empty stream, network error | Retry the same model once with full-jitter backoff (250 ms to 4 s), then fail over |
| Context overflow                                    | Fail over; if everything overflowed, `ContextTooLongError`                         |
| Model not found                                     | Fail over; if every candidate was unknown, `ProviderModelNotFoundError`            |
| 401 / 403                                           | Terminal: `ProviderAuthError`                                                      |
| 402, or a body that says the account has no credit  | Terminal: `ProviderBillingError` (ADR 0127)                                        |
| Content filter                                      | Terminal: `ContentFilteredError`, never retried or failed over                     |
| Other 400                                           | Terminal: `ProviderRequestRejectedError`                                           |

Each model gets two attempts. With every candidate used up, `UpstreamUnavailableError`, unless
every one of them was a model its provider does not know (ADR 0127).

5. **Records usage for every attempt that may have cost money.** An attempt that failed after the
   provider may have started generating (timeouts, empty streams, network errors) is recorded as
   `abandoned`. Providers offer no idempotency keys for generation, so a retry may bill twice, and
   the record says so (ADR 0040, D8). An HTTP error response is not recorded.

Provider error text is matched against patterns but never logged or returned. Surfaces see only our
typed errors.

### Streaming transport

The api writes SSE directly with backpressure, sends `x-accel-buffering: no`, and hijacks the reply
after the commitment window. Caddy proxies `/v1` with `flush_interval -1` and no compression, since
either would buffer the stream. An error before the first chunk is an ordinary JSON error with a real
status. An error after it is one SSE error frame (`stream_interrupted`, `budget_exceeded`,
`access_revoked`, `server_shutting_down`).

---

## Models, prices and cost

### The catalogue

- [`packages/core/catalogue/models.json`](packages/core/catalogue/models.json) ships in the image.
  It is generated from LiteLLM's price list at a pinned commit of its main branch by
  `pnpm catalogue:update` and reviewed by hand. It currently lists 179 models across the eight
  first-party providers. The update leaves out models whose reasoning is priced apart from their
  output, since usage counts reasoning as output and a cap could be overspent; a zero cache price
  is read as unknown (ADR 0126).
- Each entry has a context window, maximum output, capabilities (`vision`, `pdf`, `tools`,
  `structuredOutput`, `promptCaching`, `reasoning`), prices in micro-USD per million tokens (input,
  output, cache read, cache write) and optional long-context tiers. Qwen's price brackets by input
  size become those tiers.
- The api refuses to start if the file is invalid (ADR 0037).
- Instance admins add **custom models** (`custom_models`) for anything else, including
  OpenAI-compatible endpoints. A custom model cannot reuse a catalogue id.
- Every model has a display name for people: made from its id by `modelDisplayName` in contracts,
  or set on a custom model (ADR 0092).
- [`resolveModel`](packages/core/src/models/service.ts) looks in the bundled catalogue, then the
  custom models, then models only the price feed lists. A model found in none has no price, and is
  refused.
- The catalogue is read through a `CatalogueStore`. `handleModelRequest` pins one catalogue for the
  whole request ([`pinCatalogue`](packages/core/src/models/catalogue.ts)), so its reservation,
  dispatch and usage rows use the same prices.

There is no `model_pricing` table. Instead, each usage row stores a copy of the prices it was
charged at (ADR 0039).

### The signed price feed

Opt-in and off by default (PR-6, ADR 0116). `models.json` carries a `serial`, which
`pnpm catalogue:update` raises; `pnpm catalogue:sign` signs it as
[`feed/catalogue-v1.json`](feed/catalogue-v1.json), committed to main. An instance with price
updates on fetches it from the repository's raw URL on main, or from the mirror
`LAKKA_CATALOGUE_FEED_URL` names.

- [`feed.ts`](packages/core/src/models/feed.ts) checks a feed file: Ed25519 over
  `"lakka-catalogue-feed-v1\n"` and the payload bytes, against the public keys in
  [`feed-keys.ts`](packages/core/src/models/feed-keys.ts): the project owner's primary key, which
  signs every feed, and a backup key. Their private halves are held offline by the owner; a build
  with an empty list cannot turn the feed on. Then `mergeFeed` refuses the whole feed for a
  provider that is not first-party, a zero price, a tier that lowers a price, more than 2000
  models, or a cut below a quarter of a bundled price. A feed never removes a model; models only
  it lists rank below custom models.
- [`feed-check.ts`](packages/core/src/models/feed-check.ts) is the worker's `catalogue-feed` job:
  nothing while the row says off, else once a day at the instance's minute or on Check now. https
  only, no redirects, 10 s, 1 MB, `user-agent: lakka`. A serial below the last applied is a
  replay. The file is stored in `catalogue_feed` in one transaction.
- [`catalogue-reloader.ts`](packages/core/src/models/catalogue-reloader.ts) is the api's store: a
  30 s poll of the row, and the stored file verified again on every load. One that fails is ignored
  and the bundled prices apply; it never blocks startup.
- [`feed-service.ts`](packages/core/src/models/feed-service.ts) serves the Price updates card on
  the Models page: instance admins only, never a key. Turning it on and Check now are refused when
  `LAKKA_CATALOGUE_FEED_URL=off` or the keyring is empty.

### Cost of an attempt

[`priceUsage`](packages/core/src/costs/pricing.ts) prices what the provider reported:

```
cost = ceil(( uncached_input * input
            + cache_read     * cache_read_price   (input price if none)
            + cache_write    * cache_write_price  (input price if none)
            + output         * output ) / 1e6)     in micro-USD, rounded up once
```

- If the provider reported no input count, the upper estimate is billed and `usage_estimated` is set.
  If its total and uncached counts disagree, the larger reading is billed.
- If it reported no output count, the upper estimate of the visible output is billed; a reasoning
  model is charged its full output limit.
- The tier is chosen from the total input.

[`recordUsage`](packages/core/src/costs/record.ts) writes one `usage` row per attempt with tokens,
applied prices, cost, latency, time to first token, finish reason, outcome, surface, and the routing
decision (`resolution_rule`, `route_id`, `route_confidence`, `default_reason`, `was_overridden`,
`overridden_model`, `budget_fallback_from`). Money is always integer micro-USD (ADR 0019).

---

## Conversations and attachments

- A request is stateless unless it names a conversation: with the `x-lakka-conversation` header
  on the API, or always in chat (ADR 0057, G4). A request with no conversation stores no text
  (invariant 9).
- Conversations belong to a person, not a key: a key's conversation belongs to its owner. The
  routes in [`conversation-routes.ts`](apps/api/src/conversation-routes.ts) create, list, rename,
  delete and read conversations. They never write messages; only the pipeline does, through
  `/v1/chat/completions`.
- The user's turn is stored only once the request is committed, after the first chunk, so a
  refused or failed request leaves the history as it was. The reply is stored when the stream ends,
  with its `state` (`complete`, `interrupted`, `aborted`), model, routing rule, route, classifier
  confidence, default reason, and the model and cap of any budget fallback (ADR 0092).
- Tool rounds are stored as assistant messages with `tool_calls` (id and name) and `tool` messages
  with the result. Tool arguments are kept only in the tool audit, not in `messages`.
- Reading a conversation ([`pipeline/conversations.ts`](packages/core/src/pipeline/conversations.ts))
  adds what chat shows about each reply: model display names, the request's cost from `usage` on
  its last reply, and each server-side tool call from the audit, arguments included, for the
  conversation's owner only (ADR 0092).
- Attachments (PNG, JPEG, GIF, WebP, PDF and UTF-8 plain text; 10 MB per file, 20 MB per message)
  are stored as `bytea` in `attachments`. Provider APIs keep no state, so files are sent again on
  later turns; the client refers to them by `file_id` instead of uploading them again (ADR 0062).
  They are served back with `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, and
  inline only for images.
- A plain text file is never sent to a provider as a file. The gateway gives every model its text
  in place of the file, as `<document name="...">` and the text, then `</document>`
  ([`gateway/text-document.ts`](packages/core/src/gateway/text-document.ts), ADR 0106).

---

## Tools and MCP

Lakka is an MCP client. A workspace admin connects MCP servers and turns their tools on; a
model in a conversation can then call them, as the person who is asking (ADR 0066 to 0073, 0117,
0118).

### Servers and credentials

- **Transports.** Streamable HTTP servers can be added by workspace admins, but must be public https
  unless their origin is in `LAKKA_MCP_PRIVATE_ORIGINS`. stdio servers run a command in the
  `sandbox` container, so only instance admins may add one, and the command must already be in the
  image or a volume mounted there ([`mcp/servers.ts`](packages/core/src/mcp/servers.ts), ADR 0118).
- **Auth modes.** A server uses one of three:
  - `none`;
  - `shared`: one credential set by an admin, recorded as that admin's on every call;
  - `oauth`: each person connects their own account (TL-2, ADR 0068).
- **Per-user OAuth** ([`mcp/oauth.ts`](packages/core/src/mcp/oauth.ts)):
  - It uses MCP authorization discovery, dynamic client registration when offered (or an
    admin-entered client), PKCE, resource indicators, and single-use state.
  - Tokens are stored per `(server, person)` and refreshed under a row lock. A failed refresh deletes
    the token, and the person reconnects.
  - Changing the server's URL or auth mode forgets everyone's tokens.
  - Every OAuth request follows the server's own network rule, and every origin the server's
    metadata names must be on the allowlist.
- **The origin allowlist** (NF-S4, ADR 0117). Instance admins list the exact origins MCP servers
  and their authorization servers may be at, in `mcp_allowed_origins`; origins in
  `LAKKA_MCP_PRIVATE_ORIGINS` count as listed. [`mcp/egress.ts`](packages/core/src/mcp/egress.ts)
  reads it on every connection, never cached, and turns it into what that connection may reach.
  It is checked when a server is saved, tested or synced, when a person connects or a token is
  refreshed, and at stage 5 of every tool call. Servers that existed before the list were listed by
  the upgrade (`source = 'upgrade'`); an OAuth one lists its discovered origins once, through
  `egress_grandfathered`. A stdio server keeps to it through the egress proxy (ADR 0118).
- **The network rule** ([`net/`](packages/core/src/net)):
  - [`egress-policy.ts`](packages/core/src/net/egress-policy.ts) holds `normaliseOrigin` and
    `decideEgress`, one pure function for whether an origin may be reached and whether its name
    must resolve to public addresses (only an instance admin's server, or an origin the operator
    listed as private, may be on a private network).
  - [`guarded-fetch.ts`](packages/core/src/net/guarded-fetch.ts) is the only fetch for MCP traffic,
    every server's. It applies the policy to every request, resolves the host at connection time
    so DNS rebinding cannot get around it, never follows redirects, and pools connections per
    fetch so one made under another rule is never reused.
  - [`public-address.ts`](packages/core/src/net/public-address.ts) says what a public address is;
    alert webhooks use its public-only lookup too.
- A client is opened per operation and always closed; there is no connection pool across
  operations.

### Tools and the allowlist

`syncMcpServerTools` lists a server's tools and stores them in `workspace_tools`. What the model is
offered is the stored definition, not a live listing. The server records when it last synced and,
if that failed, why, as our own code (ADR 0096).

- **Names.** A server's name is a slug, and the model sees a tool as `<server>__<tool>`. People
  see the server's optional display name, or one made from the slug (ADR 0096).
- **Default state.** Every tool starts disabled (the allowlist, TL-3). A tool its server marks
  `readOnlyHint` needs no approval by default; every other tool does. Annotations are the server's
  hints and never override an admin.
- **Unusable tools.** A tool whose schema is not an object, is over 64 KB, or cannot be compiled is
  marked unusable and cannot be enabled.
- **What a request is offered.** [`resolveTools`](packages/core/src/mcp/tools.ts) filters the
  snapshot's enabled tools to the servers the acting person can use right now. For example, an OAuth
  server they have not connected is left out. The list of available tools people read shows those
  too, marked with what blocks them (`not_connected`, `no_credential`).

### The dispatch seam

Every tool call from a model goes through
[`dispatchToolCall`](packages/core/src/tools/dispatch.ts), in this order (invariant 7):

| #   | Stage                                                                         | On failure                                                  |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Existence: the name is a known tool                                           | `rejected`, fixable; lists valid names                      |
| 2   | Allowlist: it was offered to this request                                     | `denied`, terminal                                          |
| 3   | Schema: an object, at most 16 KB, valid against the tool's JSON Schema        | `rejected`, fixable; up to 5 issues described               |
| 4   | Semantic: nesting depth at most 20 (MCP tools carry no semantics Lakka knows) | `rejected`, fixable                                         |
| 5   | Authorization: the server's origin is allowed, then as the end user           | `denied`, terminal; `origin_not_allowed` or `no_credential` |
| 6   | Approval: required and no standing grant                                      | `approval_required`; nothing runs                           |
| 7   | Execute: through the `ToolExecutor`, 30 s timeout                             | `timeout` (retryable), `failed`                             |
| 8   | Shape: text kept, media replaced by placeholders, cut at 16 KB with a note    | `failed` if the tool reported an error                      |

- **Audit.** Every outcome is written to `tool_invocations`, with its status, reason, duration, and
  whose credential was used (`credential_principal_id`). Arguments are stored there too, capped at
  16 KB, as TL-6 requires. They never go to logs or spans.
- **Retries.** An unreachable server is retried once, and only for a tool marked read-only or
  idempotent.

### The tool loop

[`toolLoop`](packages/core/src/pipeline/tool-loop.ts) runs the model and the tools round by round.

**Rounds**

- Each round streams its text to the client.
- A round that ends in `tool-calls` runs the calls through the seam, appends the results, and asks
  the model again.
- Results reach the model only as `tool` messages, framed by
  [`delimitToolResult`](packages/core/src/tools/shape.ts) as `<tool_result name="...">...</tool_result>`.
  Any delimiter inside the result is escaped, and so is the name, since an unknown tool is answered
  under whatever name the model sent. A system note says results are data; that note helps, but the
  defence is structural (NF-S8, H7).

**Limits** ([`ToolLoopGuard`](packages/core/src/tools/guard.ts))

- At most 8 rounds.
- A tool is set aside after 3 consecutive failures or one terminal failure.
- A repeated identical call ends the loop.
- When the loop stops early, the model is asked once more without tools, so the person still gets
  an answer.

**Budgets**

- Every round after the first reserves on its own, for the one model that answered the first, with
  no fallback.
- A cap with no room ends the run and keeps what was done.
- Each round settles only its own attempts; attempt numbers continue across rounds under one request
  id (H8).
- A round the loop leaves early (it broke, was aborted or revoked, or its reader stopped) is still
  settled before the reply ends; the sweep is only the backstop for a killed process (ADR 0089).

**Approvals.** An approval ends the run instead of blocking it (tech spec, Approval).

- The final chunk carries `lakka.pending_approval` (id, tool, arguments), and a `tool_approvals`
  row waits.
- The client answers with `x-lakka-approve: <id>` (optionally with `x-lakka-approve-scope:
  always`) or `x-lakka-deny: <id>` on the next request in the conversation.
- The pipeline records the answer, runs the paused calls, then continues.
- Only the person who asked can answer, and only a person, not a key, can grant a tool for good.
- Standing grants live in `tool_grants` and can be revoked by the person or an admin (TL-5).

**Client-defined tools.** OpenAI `tools` a client brings are passed to the model and returned as
`tool_calls` for the client to run (H4). Mixing them with workspace tools in one request is refused.

### Where tools run

`ToolExecutor` takes plain data (target, secret, tool name, arguments, timeout) and both calls a
tool and lists a server's tools, so testing and syncing run a server where its calls do. The
target carries the origins the operation may reach, so whatever runs it keeps to the allowlist.
[`byTransport`](packages/core/src/tools/executor.ts) picks the executor per transport; the api
requires one and never falls back to running a server in process.

- **HTTP servers** run from the api: `inProcessExecutor`, through the guarded fetch.
- **stdio servers** run in the sandbox (NF-S4, ADR 0118):
  - [`sandboxExecutor`](packages/core/src/tools/sandbox.ts) POSTs each operation to the tool host
    on its unix socket, with the bearer token from `sandbox-keys`, and puts a fresh egress token
    ([`net/egress-token.ts`](packages/core/src/net/egress-token.ts), HMAC over the operation's
    rule, at most 45 s) in the proxy URL. If the tool host cannot be reached or is busy past the
    deadline, or a key is missing, the operation fails as `unreachable`.
  - The tool host ([`apps/api/src/sandbox/tool-host.ts`](apps/api/src/sandbox/tool-host.ts),
    [`slots.ts`](apps/api/src/sandbox/slots.ts)) takes a free slot, a uid from 61000 up, and
    starts `lakka tool-runner` as that uid under prlimit (64 processes, 1 GiB of data, 120 s of
    CPU, 256 files). The data limit counts reserved memory too, and Node needs 1 GiB of it to
    start on amd64. Afterwards, or when the api goes
    away, it kills everything the uid owns and empties its home, running the cleanup as the uid.
  - The runner hands the server `HTTPS_PROXY`, `HTTP_PROXY` and `NODE_USE_ENV_PROXY=1`.
  - The egress proxy ([`apps/api/src/sandbox/egress-proxy.ts`](apps/api/src/sandbox/egress-proxy.ts))
    checks the token, decides with `decideEgress` and
    [`decideProxyEgress`](packages/core/src/net/egress-proxy-policy.ts), never reaches
    Lakka's own services, and connects to the address it checked.
  - `pnpm dev` runs stdio servers in the api instead (`LAKKA_TOOL_HOST_URL=in-process`), with
    a warning; the production image refuses that setting.
- **The runner protocol** ([`tools/runner.ts`](packages/core/src/tools/runner.ts)) is one JSON line
  on stdin, including the credential (so it never appears in argv or the environment), and one
  line back. It is version 3: `op: call | list`, the operation, and the egress proxy; a runner
  refuses any other version. The runner imports `@lakka/core/runner`, not all of core.
- **Out of process anywhere.** `commandExecutor` spawns a runner, such as one in a container; CI
  runs a tool through it in the app image with no network at all (TL-8, ADR 0073).

---

## Observability

### Tracing

- **Setup.** [`createTracing`](packages/core/src/observability/tracing.ts) builds an OpenTelemetry
  `BasicTracerProvider` that is deliberately **not registered globally**, so libraries such as
  Better Auth and Drizzle cannot emit spans carrying SQL or emails.
- **Where spans go.** They are batched into Postgres by
  [`postgresSpanExporter`](packages/core/src/observability/exporter.ts), and also to an OTLP/HTTP
  endpoint only if an operator sets `LAKKA_OTLP_ENDPOINT` (OB-5, ADR 0080). The standard `OTEL_*`
  variables are ignored on purpose.
- **Attribute allowlist.** Every exporter keeps only attributes in `STORED_ATTRIBUTES`
  ([`gateway/telemetry.ts`](packages/core/src/gateway/telemetry.ts)): the GenAI semantic-convention
  names, our `lakka.*` names, and `error.type`. Span status messages stay generic.
- **Failures.** A span that fails to export is dropped and logged; it never fails a request.

The span tree for one request:

```
request                        SERVER                    surface, principal, acting user, outcome,
 |                                                       and the decision, cap and provider below
 |- policy.authorize                                     error code if refused
 |- policy.rate_limit                                    the wait in ms, if refused
 |- policy.resolve_model                                 requested, rule, route, confidence,
 |                                                       threshold, signal, reason
 |- policy.reserve_budget                                caps, estimate, held, scope, left,
 |                                                       fallback model and its estimate
 |- gateway.dispatch                                     candidates skipped (events)
 |   '- chat <model>           CLIENT, one per attempt   tokens, cost, ttft, finish reason
 |- execute_tool                                         tool, status, credential principal
 '- policy.reconcile                                     reserved, actual, delta
```

The request span carries what the request list shows, so the list needs no other table: what was
asked for, the routing rule, route, confidence and threshold, the cap that had no room and what it
had left, and the provider that did not answer. A request that carries a tool approval names the
request it continues (`lakka.continues_request_id`), and the two are read as one trace
(ADR 0095).

### Content capture

Content capture is off by default (OB-4). A workspace admin can turn it on, with a retention of 1 to
90 days (default 7), and everyone in the workspace can see whether it is on
([`observability/capture.ts`](packages/core/src/observability/capture.ts), ADR 0077).

- **What is written.** When it is on, each attempt writes the prompt and response to
  `span_content`, capped at 256 KB, with file parts reduced to type and size. The prompt and
  response are never written into span attributes.
- **Where content lives.** Prompt and response text is stored in exactly three places:
  - `messages` and `attachments`, as conversation history the user asked for;
  - `span_content`, only when opted in;
  - `tool_invocations.arguments`, as the tool audit.

  A message an admin adds to a route from the candidates becomes a row in `route_examples`, policy
  the admin wrote, and outlives its source (ADR 0114).

### Retention

The pg-boss job `retention` runs daily at 03:17 UTC under an advisory lock
([`observability/retention.ts`](packages/core/src/observability/retention.ts), ADR 0078).

- **How rows are removed.** `spans` and `usage` are partitioned by month, so the job drops whole
  partitions past the window and deletes the remainder inside the cutoff month. Everything else is a
  delete by date.
- **Defaults.** Instance admins can change these, and can run the job on demand. A run asked for
  while another is going answers `retention_running` (409). Each run records what it removed and
  how long it took (ADR 0097).

| Data                                          | Default                           |
| --------------------------------------------- | --------------------------------- |
| spans                                         | 30 days                           |
| captured content                              | its own expiry, set per workspace |
| usage                                         | 13 months                         |
| conversations                                 | kept until deleted                |
| tool audit, decided approvals, revoked grants | 90 days                           |
| budget alerts                                 | 13 months                         |
| closed reservations                           | 30 days                           |
| expired MCP OAuth states                      | always removed                    |
| expired password reset links                  | always removed                    |

Budget counters are rebuilt from `budget_spend`, so pruning `usage` never changes a cap.

### Trace UI and usage views

[`observability/traces.ts`](packages/core/src/observability/traces.ts) serves the request list and
the trace view (OB-1, ADR 0079).

- **Who sees what.** Instance and workspace admins see every request in the workspace. Members see
  their own and their keys' requests. Keys cannot read traces.
- **The list.** It filters by person (admins only), surface, outcome (completed, cheaper, refused,
  stopped, failed) and UTC days, returns the total, and pages by start time and span id. A request
  that paused for an approval is listed once, with the time and cost of the requests that
  continued it (ADR 0095).
- **What the trace view shows.** The span tree of the request and any that continued it, the
  attempts from `usage`, the approval waits, and any captured content.

### Logging

All logging goes through [`createLogger`](packages/core/src/logger.ts), a pino wrapper that
enforces invariant 9 structurally (ADR 0005). Only `logger.ts` may import pino.

- **Event names.** They must be dotted snake case.
- **Fields.** Only fields named in `LOG_FIELDS` are kept, with strings truncated to 256 characters.
- **Errors.** An error keeps its name, a safe code and its stack; its message is kept only for our
  own `LakkaError`s.
- **Framework logs.** The same filter is applied to Fastify's logger.
- **Caddy.** It writes no access log, because query strings may carry keys.

### Health and diagnostics

- **`/healthz` on the api.** It checks Postgres and Valkey (required), and the classifier and each
  instance provider credential (optional, 60 s cache). A failed optional check makes the status
  `degraded`, which still answers 200; a failed required check answers 503 (ADR 0017, 0081).
- **The worker's health port.** It answers 200 only when every check passes.
- **The sandbox.** `/healthz` does not check it. `sandbox` and `egress` have compose health checks
  of their own, and the api does not depend on them (ADR 0118).
- **The diagnostics bundle.** It is available as `lakka diagnostics` or `GET /api/diagnostics`,
  for instance admins ([`diagnostics/bundle.ts`](packages/core/src/diagnostics/bundle.ts),
  ADR 0083). It is built from an allowlist field by field, never by redacting a dump, because
  redaction fails open. The command asks the running api's `/healthz` how the classifier is,
  rather than loading a second copy of the model. It holds:
  - system, config and health summaries;
  - database, cache and job facts, the credential key versions (never a key), and whether price
    updates are locked or on and what their last check found (never the feed);
  - `sandbox.json`: whether the tool host and the egress proxy answer, and whether their key
    files are there (never a key);
  - the last 24 hours of error spans, without principal or conversation ids.

  It never contains credentials, prompts, names, emails, or provider and MCP addresses; config values
  appear only as origins and "set or not" flags. CI checks that no secret value appears in it.

---

## Data model

Schema: [`packages/db/src/schema/`](packages/db/src/schema). Queries:
[`packages/db/src/queries/`](packages/db/src/queries). Migrations:
[`packages/db/migrations/`](packages/db/migrations) (`0000` to `0039`).

### Tables by domain

| Domain               | Tables                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity             | `principals` (people and keys, with tombstones), `workspaces` (with tombstones), `memberships`, `api_keys`                                                          |
| Better Auth          | `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`                                                                                                |
| SSO                  | `sso_providers` (Better Auth plugin), `sso_provider_policies` (ours)                                                                                                |
| Onboarding           | `instance_setup` (single row), `invites`, `password_resets`                                                                                                         |
| Providers and models | `provider_configs` (instance or workspace), `custom_models`, `catalogue_feed` (single row: the price feed switch and the last feed applied)                         |
| Routing              | `routes`, `route_examples`, `route_centroids` (pgvector columns, and their source), `route_candidate_decisions` (no text)                                           |
| Conversations        | `conversations`, `messages`, `attachments`                                                                                                                          |
| Budgets              | `budgets`, `budget_spend`, `reservations`, `reservation_lines`, `alert_webhooks`, `budget_alerts`                                                                   |
| Usage                | `usage` (partitioned monthly, no foreign keys)                                                                                                                      |
| MCP and tools        | `mcp_servers`, `mcp_credentials`, `mcp_oauth_states`, `workspace_tools`, `tool_invocations`, `tool_approvals`, `tool_grants`, `mcp_allowed_origins` (instance-wide) |
| Observability        | `spans` (partitioned monthly), `span_content`, `retention_settings` (single row)                                                                                    |
| Encryption           | `credential_keys` (key versions and fingerprints, never a key)                                                                                                      |
| Jobs                 | the `pgboss` schema, owned by pg-boss                                                                                                                               |

### Conventions

- **Ids.** Ids are UUIDv7, generated in the app because Postgres 16, the supported minimum, has no
  `uuidv7()` (ADR 0010, 0027). Their time ordering is used by the counter rebuild and by export
  paging.
- **Types.** Money is `bigint` micro-USD in `*_micro_usd` columns. Time is `timestamptz`.
- **Constraints do real work.** Examples:
  - composite foreign keys that force a principal to be a user or a key;
  - `threshold_down >= threshold_up` on routes;
  - `input_tokens = uncached + cache_read + cache_write` on usage;
  - one live reservation per request (a partial unique index);
  - one pending approval per conversation;
  - a workspace provider credential that cannot point at a custom address.
- **No foreign keys on `usage`, `spans` or `span_content`.** Spend history must outlive what it
  refers to, and foreign keys would slow inserts into partitioned tables.
- **Partitions.** `ensureMonthlyPartitions` creates the current month and the next two for `usage`
  and `spans`. It runs at startup and daily in the worker.

### Tenant scoping

There is no row-level security. Isolation rests on the query helpers:

- **Workspace first.** Every function that touches tenant data takes the workspace id as its first
  argument after `db` and filters on it. For example, `findKey(db, workspaceId, keyId)` filters on
  `and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, keyId))`. Authorization happens in core
  before the query.
- **Variations.**
  - Owner-scoped conversations add the person.
  - Instance-or-workspace rows use a nullable scope.
  - `mcp_credentials` is scoped through its server.
  - Lookups by secret digest (keys, invites, password reset links, OAuth state) are unscoped by
    design, because the digest is all the caller has.
- **Instance-wide maintenance.** The sweep, rebuild, retention, diagnostics and person export each
  say so in a header comment.

Isolation is tested by calling the API directly with another workspace's ids and expecting 404
(AC 16; `test/e2e/m1-exit.ts`, and the integration tests).

### Deleting a workspace

An instance admin deletes a workspace by id, confirming its exact name
([`deleteWorkspace`](packages/core/src/workspaces/service.ts), ID-8, ADR 0104). The row stays as
a tombstone, because usage, reservations, spans and the tool audit point at it and the instance cap
still counts its usage. `findWorkspace` and the workspace lists skip a deleted workspace, so every
call about it answers 404.

- **At once, in one transaction**
  ([`tombstoneWorkspace`](packages/db/src/queries/workspace-deletion.ts)): `deleted_at` and
  `deleted_by_principal_id` are set and the slug becomes `deleted-<id>`, freeing the old one.
  Memberships, invites, workspace provider credentials, MCP servers (with their credentials, OAuth
  states, tools and grants) and the alert webhook are deleted, its keys are revoked, and pending
  approvals expire. Then each former member and key gets a `workspace_deleted` revocation event,
  so open streams end and settle as on any abort.
- **In the background**
  ([`purgeDeletedWorkspaces`](packages/core/src/workspaces/purge.ts)): the worker's
  `workspace-purge` job runs every minute and works through every deleted workspace whose
  `purged_at` is empty, 500 rows per statement. It removes captured content, spans and
  conversations (with messages and attachments), and erases the tool audit's arguments. Then,
  once no reservation in the workspace is pending or active, it removes the routes and caps and
  sets `purged_at` in one transaction, then deletes the caps' Valkey counters. A failure there is
  only logged: a counter left behind is never read again. Every step is safe to repeat.
- **Kept.** Usage rows, settled reservations and the tool audit without arguments, so the instance
  cap and the instance report do not move. The report lists the workspace's spend marked as
  deleted.

### Encryption at rest

[`packages/db/src/crypto.ts`](packages/db/src/crypto.ts):

- **Algorithm.** AES-256-GCM, with a random 12-byte IV and the column's name as additional
  authenticated data, so a ciphertext copied into another column fails to decrypt. The stored format
  is `v<N>:<iv>:<ciphertext and tag>`, where `v<N>` names the key version.
- **Keys** (NF-S9, ADR 0115). Each 32-byte key comes from a secret file, `credential_master_key` for
  v1 and `credential_master_key_v<N>` after it, or all of them from `LAKKA_CREDENTIAL_KEYS`, and
  is never stored in the database. Values decrypt with the key their prefix names; writes use the
  active version. Until the ring is configured, any read or write of an encrypted column throws.
- **Versions in Postgres.** `credential_keys` records each version with an HMAC fingerprint and when
  it was activated and retired, never a key. At startup
  [`credential-keys.ts`](packages/core/src/credential-keys.ts) reads the active version and refuses
  a missing or wrong key (`credential_key_missing`, `credential_key_mismatch`); the first start
  records v1 once a stored value decrypts with it. The api, the worker (alert webhooks have
  encrypted secrets) and the commands that touch credentials all configure the ring this way; the
  diagnostics command carries on without it, only its provider checks lacking keys.
- **Rotation.** [`queries/credential-keys.ts`](packages/db/src/queries/credential-keys.ts)
  re-encrypts every column the `encryptedText` helper registered, in one transaction that also
  activates the new version; [`cli/credential-key.ts`](apps/api/src/cli/credential-key.ts) writes
  the key file first and runs it with the database to itself. `retire` refuses while any text column
  still holds an older version.
- **Encrypted columns.** `provider_configs.api_key`, `mcp_credentials.secret`, `refresh_secret`,
  `mcp_servers.oauth_client`, `mcp_oauth_states.code_verifier`, `alert_webhooks.secret`,
  `sso_providers.oidc_config` and `auth_accounts.id_token`. Better Auth encrypts OAuth access and
  refresh tokens itself.
- **Hashed with SHA-256.** API keys, invite tokens, password reset tokens and OAuth state.
- **Write-only.** Credentials are write-only through the API: views return `hasKey`-style flags,
  never the value.

### Migrations

- **Generation.** `pnpm db:generate` uses drizzle-kit to write a new migration from schema changes.
  CI fails if the schema and the migrations disagree.
- **Running.** [`migrate.ts`](packages/db/src/migrate.ts) is our own forward-only runner over
  drizzle-kit's file format and table (ADR 0026). It takes a Postgres advisory lock, so api and
  worker can start together, and applies all pending migrations in one transaction.
- **Refusals.** It refuses to start when:
  - the database has a migration this version does not know (no downgrades, NF-O1);
  - an applied migration's file changed;
  - a pending migration is older than the newest applied one (merged late);
  - the journal is out of order.

  Each case has a fixture in `packages/db/test/fixtures/migrations/`.

- **Who runs it.** `ensureDatabaseReady` runs it at api and worker startup. The operator commands run
  it in `verify` mode, which changes nothing.
- **Never edit an applied migration.** Its hash is checked, so even a comment change is refused.

---

## The HTTP surface

[`buildServer`](apps/api/src/server.ts) registers every route; each file is a thin adapter that
validates input with zod, builds or reads the `Principal`, and calls one core function.

### Cross-cutting behaviour

- **Request ids.** `x-request-id` is accepted if it is well formed, otherwise generated, and always
  returned.
- **CSRF** ([`origin-check.ts`](apps/api/src/origin-check.ts), ADR 0006). The rules, in order:
  1. Safe methods pass.
  2. A request with an `Authorization` header passes.
  3. A request with an `Origin` must match a trusted origin.
  4. With no `Origin` and no cookie, the request passes.
  5. A cookie without an `Origin` needs `Sec-Fetch-Site: same-origin`.
- **Throttling.** Setup (10 per minute), the public invite endpoints (20 per minute) and the public
  password reset endpoints (10 per minute) are throttled per client address in Valkey. Sign-in is
  throttled by Better Auth. Model requests have their own per-person limit, in core
  ([The rate limit](#the-rate-limit)). All of these fail closed.
- **Security headers.** Every api response gets `default-src 'none'; frame-ancestors 'none'`,
  `nosniff` and `no-referrer`.
- **Errors.** A typed error maps to a status and a stable code through `STATUS_BY_CODE`, with the
  body `{ "error": { "code", "message" } }`. Anything else is `internal_error` and is never
  described to the client.

### Routes

| Area              | Routes                                                                                                                                                 | File                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Health            | `GET /healthz`                                                                                                                                         | `server.ts`                |
| Auth              | `/api/auth/*` (allowlisted Better Auth routes), `GET /api/me`                                                                                          | `auth-routes.ts`           |
| Setup             | `GET /api/setup`, `POST /api/setup/secrets`, `POST /api/setup`                                                                                         | `setup-routes.ts`          |
| SSO               | `/api/sso/providers[/:id]`, `GET /api/sso/providers/public`                                                                                            | `sso-routes.ts`            |
| Invites           | `/api/workspaces/:id/invites`, `POST /api/invites/preview`, `POST /api/invites/accept`                                                                 | `invite-routes.ts`         |
| Workspaces        | `/api/workspaces[/:id]` (create, read, rename, delete), members, content capture, requests                                                             | `workspace-routes.ts`      |
| Keys              | `/api/workspaces/:id/keys`                                                                                                                             | `key-routes.ts`            |
| People            | `/api/users`, suspend, reactivate, instance admin, export (tar.gz), delete                                                                             | `principal-routes.ts`      |
| Password reset    | `POST /api/users/:id/password-reset`, `POST /api/password-reset[/preview]`                                                                             | `password-reset-routes.ts` |
| Conversations     | `/api/workspaces/:id/conversations[/:cid[/attachments/:aid]]`                                                                                          | `conversation-routes.ts`   |
| Budgets and spend | `/api/budgets/instance`, `/api/workspaces/:id/budgets/...`, webhooks, alerts, spend                                                                    | `budget-routes.ts`         |
| Models            | `/api/models`, `/api/models/custom[/:id]`, `/api/models/catalogue-feed[/check]`                                                                        | `models-routes.ts`         |
| Providers         | `/api/providers[/:id[/test]]`, the same under a workspace, and its `providers/coverage`                                                                | `providers-routes.ts`      |
| Routing           | `/api/workspaces/:id/{models,requestable,routing,routes}`, `routing/settings`, `routing/try`, `routing/overrides`, `routing/candidates[/:mid/dismiss]` | `routing-routes.ts`        |
| MCP and tools     | `mcp-servers`, `mcp-connections`, `/api/mcp/oauth/callback`, `tools`, `tool-grants`, `/api/admin/mcp-origins`                                          | `mcp-routes.ts`            |
| Retention         | `/api/retention[/run]`, `/api/observability/export`                                                                                                    | `retention-routes.ts`      |
| Diagnostics       | `GET /api/diagnostics`                                                                                                                                 | `diagnostics-routes.ts`    |
| OpenAI            | `GET /v1/models`, `POST /v1/chat/completions`                                                                                                          | `openai/routes.ts`         |

### The OpenAI-compatible adapter

**Request translation.** [`openai/request.ts`](apps/api/src/openai/request.ts) translates an OpenAI
chat request into a `GatewayRequest`.

- `developer` becomes `system`.
- Images and files must be inline base64 data URLs, or a `file_id` of an earlier attachment in the
  conversation. A `text/plain` file must be UTF-8; a data URL's parameters such as `charset` are
  ignored (ADR 0106).
- `tool` messages must answer a call an earlier assistant message made.
- Fields whose meaning cannot be honoured are refused with a named `param`: legacy `functions`,
  `n != 1`, structured `response_format`, and a forced `tool_choice`. Unknown extra fields are
  accepted.

**Model choice** (API-4).

- `model: "auto"` runs the resolution order.
- `model: "route/<name>"` asks for a route.
- Anything else names a model.
- `/v1/models` lists `auto`, the routes and the models the caller may use.

**Routing details in headers.** Routing and fallback details travel in `x-lakka-*` response
headers ([`openai/headers.ts`](apps/api/src/openai/headers.ts)), never in the body (ADR 0057, G3).
A successful body carries only `lakka` extensions OpenAI clients ignore: `lakka.pending_approval`
(ADR 0066, H5), and `lakka.tool_activity` (call id, tool name, status; never arguments or
results) as each server-side tool call finishes (ADR 0092).

**Error mapping.** [`openai/errors.ts`](apps/api/src/openai/errors.ts) maps our errors to OpenAI
error bodies. The SDKs then behave correctly: an unknown model is `model_not_found`, a bad key is
`invalid_api_key`, a context overflow is `context_length_exceeded`, a budget refusal is 402
`budget_exceeded` (not retried), and a store outage is 503. A budget refusal also carries a
`lakka` extension with the cap's scope, what it had left and what the request needed; a provider
failure carries the provider, whether it was rate limited, and its `Retry-After` (ADR 0092). A
provider's billing refusal and a model id the provider does not know are 502 `provider_billing` and
`provider_model_not_found`, carrying the provider (and the model), never a 402 (ADR 0127). A
refusal by the per-person rate limit is 429 `rate_limit_error` with `Retry-After`, `retry-after-ms`
and `lakka.retry_after_seconds` (BG-12, ADR 0113).

**Graceful shutdown.** On `SIGTERM` the api stops accepting requests and waits up to 20 seconds for
live streams. It then ends the rest with an SSE `server_shutting_down` frame, settling their
budgets, and exits within the 30 seconds compose allows (NF-O5, ADR 0081).

---

## The web app

`apps/web` is a TanStack Start app with HeroUI v3 components and Tailwind CSS, rendered on the
server and hydrated.
It has no privileged access: it is an HTTP client of the api, like any other.

- **Transport** ([`lib/api.ts`](apps/web/src/lib/api.ts)).
  - During SSR it calls `LAKKA_API_INTERNAL_URL` (`http://api:3000`), forwarding only the
    incoming cookie.
  - In the browser it calls same-origin relative paths through Caddy (or the Vite proxy in
    development).
  - Errors are parsed into `ApiError(status, code)`.
- **Data.**
  - A new `QueryClient` is created per SSR request, so no user's data can leak into another's page.
  - Every query is a shared `queryOptions` in [`lib/queries.ts`](apps/web/src/lib/queries.ts). Keys
    are grouped under `['workspaces', id, ...]` so mutations can invalidate by prefix.
  - Route loaders `ensureQueryData`; components use `useSuspenseQuery`.
- **Auth gating.**
  - The pathless `_app` layout loads `/api/me` and the person's workspaces, and redirects to
    sign-in on 401.
  - Admin pages redirect non-admins, and workspace pages show sections by role.
  - This is convenience only. The api decides.
- **Pages** ([`routes/`](apps/web/src/routes)).
  - Signed in, under `_app`: the workspace list at `/workspaces`, and for each workspace its
    settings at `/workspaces/$id`, then chat, Your connections, Requests and a trace, Routing
    (a route dialog with its description, ADR 0122; Try a phrase, which says whether a route
    scored from its examples, its description or both; and a dialog per route to review the
    messages people moved away from it, ADR 0114), Spend (a report tab and a budgets tab) and
    Tools.
  - The Admin group: Workspaces, People and sign-in, Models and providers (a row per first-party
    provider, Add a provider for any OpenAI-compatible server, and the Price updates card,
    ADR 0116), Tool servers (the MCP origin allowlist, ADR 0117), Instance spend (with a
    full report), Retention and Diagnostics. A page with tabs is a layout route with one nested
    route per tab, so the tab list stays mounted (ADR 0100).
  - Signed out: `/sign-in`, `/setup` in three steps, `/invite` and `/reset`. Invite and reset
    tokens stay in the URL fragment ([`lib/fragment-token.ts`](apps/web/src/lib/fragment-token.ts),
    ADR 0098).
- **Shell** ([`components/shell/`](apps/web/src/components/shell), ADR 0090, 0107, 0110).
  - From 1024px there is a side menu, which collapses to a 64px rail of icons with tooltips.
    Below that there is a top bar with a drawer holding the same menu. Both are built from one
    model in `nav.ts`, and CSS switches between them, so there is only ever one main menu.
  - In chat, the conversations have their own column on a desktop, which can be hidden, and sit
    right under Chat in the phone drawer.
  - Three first-party cookies are read on the server, so the first paint is already right:
    `lk_workspace`, the id of the workspace used last
    ([`lib/workspace-memory.ts`](apps/web/src/lib/workspace-memory.ts)), and `lk_nav=rail` and
    `lk_conversations=hidden` ([`lib/layout-memory.ts`](apps/web/src/lib/layout-memory.ts)).
  - `/` opens chat in the workspace used last, or else the first the person belongs to. Someone in
    no workspace lands on `/workspaces`.
  - The account menu holds Sign out and the link to the source.
- **Theme** (ADR 0090, 0101, 0108).
  - `styles/lakka-theme.css` is a copy of `docs/design/theme/lakka-theme.css`, kept
    identical by a unit test, because the image build does not see `docs/`.
  - `styles/app.css` holds the type, size and radius tokens, the shared `lk-*` classes, and the
    overrides of HeroUI's component layer (ADR 0112).
  - The fonts (Atkinson Hyperlegible Next and Mono, and Newsreader) come from `@fontsource`
    packages and are served by the app, never from a CDN (NF-P1).
  - Dark mode follows the operating system, through a script in the head that carries the page's
    CSP nonce ([`lib/color-scheme.ts`](apps/web/src/lib/color-scheme.ts)).
- **Patterns and the gallery** ([`components/patterns/`](apps/web/src/components/patterns),
  ADR 0091).
  - The shared patterns (page header, card section, data table, code block, dialogs, tags field
    and the rest) each have Storybook stories on fixtures. `pnpm stories` runs Storybook, with
    telemetry, crash reports and update checks off (invariant 8).
  - `pnpm test:stories` runs every story with axe, in light and dark, at 1280px and 390px. The
    one shared list of axe exceptions is [`test/axe.ts`](test/axe.ts).
  - react-aria is patched so that a filtered list reports correct positions to screen readers
    (`patches/`, ADR 0103).
- **Chat** ([`$workspaceId_.chat.tsx`](apps/web/src/routes/_app/workspaces/$workspaceId_.chat.tsx),
  [`lib/chat.ts`](apps/web/src/lib/chat.ts)).
  - It posts to `/v1/chat/completions` with the workspace and conversation headers and parses SSE
    itself.
  - It reads the routing decision from response headers before any text, so a fallback notice
    shows at once.
  - It shows the reason for each model choice and links each reply to its trace.
  - Earlier attachments are re-sent by `file_id`.
  - Tool approvals are answered with the approval headers.
  - A refusal by the rate limit says how long to wait, from `lakka.retry_after_seconds`.
  - **Replies are Markdown** ([`components/chat/markdown.tsx`](apps/web/src/components/chat/markdown.tsx),
    ADR 0105), parsed by `react-markdown` with `remark-gfm` into React elements. No HTML string
    reaches the page and raw HTML is dropped. Links work only for http, https and mailto, and an
    image is never loaded: it becomes a link to its address. The person's own messages stay
    plain text.
  - **Files** ([`lib/attachments.ts`](apps/web/src/lib/attachments.ts), ADR 0106). Files can be
    picked, dropped on the conversation or pasted. Text files of many kinds (notes, code,
    data) are sent as `text/plain` with their names, and a paste over 2,000 characters becomes a
    text file.
- **Forms before hydration** ([`components/safe-form.tsx`](apps/web/src/components/safe-form.tsx),
  ADR 0044). Every form is `method="post"` inside a fieldset that is disabled until React hydrates,
  so a secret typed early can never end up in a GET URL.
- **Security headers** ([`lib/security.ts`](apps/web/src/lib/security.ts), ADR 0085).
  - In production each document gets a nonce-based CSP with `'strict-dynamic'`,
    `frame-ancestors 'none'`, `object-src 'none'` and `base-uri 'none'`.
  - It also gets `nosniff`, `same-origin` referrer and opener policies, and a restrictive
    permissions policy.
- **AGPL notice.** A link to the running version's source (`LAKKA_SOURCE_URL`, or the
  repository at `LAKKA_REVISION`), read at serve time (AD-6,
  [`lib/source-url.ts`](apps/web/src/lib/source-url.ts)). It is in the account menu on signed-in
  pages and in the footer of the signed-out ones (ADR 0107).
- **Text.** All UI copy is in [`i18n/en.ts`](apps/web/src/i18n/en.ts), typed by key and checked to
  be ASCII. `pnpm check:copy` also bans non-ASCII characters and `+` used as "and" anywhere in
  `apps/web/src`, and in the site's pages and source. Money is formatted from micro-USD strings
  with BigInt, never floats. Dates are shown in UTC so server and client render the same.

---

## The worker and background work

[`apps/worker/src/main.ts`](apps/worker/src/main.ts) migrates, then starts:

| Work                                             | Schedule                                             | Function                  |
| ------------------------------------------------ | ---------------------------------------------------- | ------------------------- |
| Budget maintenance: sweep, rebuild, queue alerts | every 30 s (rebuild every 5 min), advisory lock      | `startBudgetMaintenance`  |
| `budget-alert` (pg-boss)                         | on demand, one job per alert, 8 retries with backoff | `deliverBudgetAlert`      |
| `retention` (pg-boss)                            | daily 03:17 UTC                                      | `enforceRetention`        |
| `workspace-purge` (pg-boss)                      | every minute, one run at a time, no retries          | `purgeDeletedWorkspaces`  |
| `catalogue-feed` (pg-boss)                       | every minute; contacts nothing unless on and due     | `checkCatalogueFeed`      |
| Monthly partitions                               | every 24 h (and at every startup)                    | `ensureMonthlyPartitions` |

- pg-boss uses the worker's own pool and the `pgboss` schema, so jobs live in Postgres, not in a
  third store.
- The api runs no scheduled work. Its only background work is the revocation watcher, the lazy
  classifier load, a centroid rebuild after the embedding model changes, and a 30 s read of the
  price feed's row (ADR 0116). A test alert is sent from the api only when an admin asks for one.
- Every periodic job takes an advisory lock or is de-duplicated by pg-boss, so an overlapping run,
  for example during a restart, does no harm.

---

## Configuration and secrets

[`loadConfig`](packages/core/src/config.ts) is a pure function over the environment and a secret
reader, used by api, worker and the CLI. The web process reads its own few variables
(`LAKKA_WEB_{HOST,PORT}`, `LAKKA_API_INTERNAL_URL`, and `LAKKA_SOURCE_URL` and
`LAKKA_REVISION` for the source link).

- **Validation.** It is validated with zod. Error messages name variables, never values, and an
  empty string counts as unset.
- **Secret sources.** Every secret can come from an environment variable or a file in
  `LAKKA_SECRETS_DIR`.
- **Reference.** The operator reference is
  [`docs/guide/configuration.md`](docs/guide/configuration.md).

| Group            | Variables                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Stores           | `LAKKA_DATABASE_{HOST,PORT,USER,NAME,PASSWORD}`, `LAKKA_CACHE_{HOST,PORT,PASSWORD}`                                 |
| Processes        | `LAKKA_API_{HOST,PORT}`, `LAKKA_WORKER_HEALTH_{HOST,PORT}`, `LAKKA_WEB_{HOST,PORT}`, `LAKKA_API_INTERNAL_URL` (web) |
| Public address   | `LAKKA_DOMAIN`, `LAKKA_HTTP_PORT`, `LAKKA_PUBLIC_URL` (a bare origin; it sets cookies and trusted origins)          |
| Secrets          | `LAKKA_AUTH_SECRET`, `LAKKA_CREDENTIAL_KEY`, `LAKKA_CREDENTIAL_KEYS`, `LAKKA_SETUP_CODE`, `LAKKA_OTLP_HEADERS`      |
| Private networks | `LAKKA_OIDC_PRIVATE_ORIGINS`, `LAKKA_MCP_PRIVATE_ORIGINS`                                                           |
| Classifier       | `LAKKA_CLASSIFIER_MODEL_DIR`, `LAKKA_CLASSIFIER_THREADS`                                                            |
| Sandbox          | `LAKKA_TOOL_HOST_URL`, `LAKKA_EGRESS_PROXY_URL`, `LAKKA_SANDBOX_SLOTS`; compose's `LAKKA_SANDBOX_MEMORY` (ADR 0118) |
| Rate limit       | `LAKKA_MODEL_REQUESTS_PER_MINUTE`, `LAKKA_MODEL_REQUEST_BURST` (BG-12)                                              |
| Export           | `LAKKA_OTLP_ENDPOINT` (unset: nothing leaves the instance)                                                          |
| Price feed       | `LAKKA_CATALOGUE_FEED_URL` (a mirror, or `off` to lock it; contacted only once an admin turns it on)                |
| Build            | `LAKKA_VERSION`, `LAKKA_REVISION`, `LAKKA_SOURCE_URL`                                                               |
| Logging          | `LAKKA_LOG_LEVEL`                                                                                                   |

**First-run secrets** ([`cli/init-secrets.ts`](apps/api/src/cli/init-secrets.ts), ADR 0004).

- The `init` service creates `database_password`, `cache_password`, `auth_secret`,
  `credential_master_key` and `setup_code`, each 32 random bytes, and regenerates `valkey.conf` from
  the cache password.
- Existing files are never overwritten, and values are never printed. Once a numbered key file
  `credential_master_key_v<N>` exists, `credential_master_key` is never created again: the key was
  rotated, and a fresh v1 would be a key nothing was encrypted with (ADR 0115).
- Losing the active credential key loses every stored credential, which is why setup shows it once,
  `lakka recovery-key` prints it after a rotation, and backups include it.
- It also writes the sandbox's keys, each into its own volume when it is mounted: the tool host's
  token (`tool_host_token`) into `sandbox-keys`, read by the api and the sandbox, and the egress
  signing key (`egress_token_key`) into `egress-keys`, read by the api and the proxy. Both are
  root:node, mode 0440, so no slot's uid can read them. They are not backed up; a missing one is
  made anew (ADR 0118).

---

## Deployment

### The compose stack

- [`compose.yaml`](compose.yaml) includes [`docker/compose.yaml`](docker/compose.yaml), which needs
  no edits (NF-D3).
- **Exposure.** Only Caddy publishes ports, on loopback by default. `LAKKA_HTTP_BIND` opens it
  wider, and `LAKKA_DOMAIN` turns on automatic HTTPS (ADR 0008).
- **Secrets.** The `web`, `sandbox` and `egress` services mount no secrets.
- **The sandbox** (ADR 0118). `sandbox` is root with every capability dropped but SETUID and
  SETGID, `no-new-privileges`, a read-only root and a tmpfs `/tmp`, capped at 512 processes and
  `LAKKA_SANDBOX_MEMORY`. It is only on the internal `sandbox` network, with `egress`; the api
  reaches it on a socket in the in-memory `tool-host` volume. Docker Engine 26 or later is needed,
  so the internal network resolves no outside names. The api does not depend on it.
- **Volumes.** `secrets`, `sandbox-keys`, `egress-keys`, `tool-host` (in memory), `postgres-data`,
  `valkey-data`, `caddy-data` and `caddy-config`.

### Caddy

- **Routing.** [`docker/Caddyfile`](docker/Caddyfile) sends `/api`, `/v1` and `/healthz` to `api`
  with `flush_interval -1`, and everything else to `web`, so the browser sees one origin.
- **Quiet by default.** The admin API is off, and there is no access log and no compression.
- **Custom build.** Caddy is compiled from source ([`docker/caddy.Dockerfile`](docker/caddy.Dockerfile))
  onto Debian slim. The official image is Alpine and carries fixable vulnerabilities in its Go
  toolchain (ADR 0011, 0086). Its Debian stage takes Debian's security fixes at build time, as the
  app image does (ADR 0099).

### The app image

[`docker/Dockerfile`](docker/Dockerfile) builds on `node:24.21.0-trixie-slim`. It is never Alpine,
because onnxruntime-node has no musl build.

**Stages**

1. `base`
2. `manifests`: only the `package.json` files and `patches/`, for layer caching
3. `build`: installs everything and builds web
4. `prod-deps`: production dependencies; prunes the ONNX Runtime binaries to the target
   architecture and removes build tools the scanner flags
5. `models`: fetches and verifies both classifiers' weights, the files for the target
   architecture only
6. `runtime`: runs `apt-get upgrade` at build time, so a fix Debian has released is in the next
   build whatever the base image's age (ADR 0099); without npm, npx or corepack; runs as
   `USER node`

**Entrypoint.** [`docker/entrypoint.sh`](docker/entrypoint.sh) is installed as `lakka`. Its
subcommands are `api`, `worker`, `web`, `init`, `migrate`, `create-user`, `setup-code`,
`recovery-key`, `credential-key`, `diagnostics`, `tool-runner`, `tool-host`, `egress`,
`classifier-eval` and `embed-bench`.

**Size and start time.** At the M10 gate, with both classifiers, the two images together were
502 MB on amd64 against a 1 GB budget, and cold start reached the setup screen in about 15
seconds against a 30-second limit (AC 3). CI checks both limits on every run.

### Offline start

- The image holds everything it needs, including the model weights, and nothing downloads at boot
  (NF-D5).
- CI proves it in two ways:
  - it starts a release bundle on a compose network with no route out
    ([`docker/compose.offline.yaml`](docker/compose.offline.yaml));
  - it runs the embedding benchmark and the routing evaluation with `--network none`.

### Backup, restore and upgrade

- **Backup** ([`docker/backup.sh`](docker/backup.sh), ADR 0084). `docker compose run --rm backup`
  writes one `.tar.gz` holding a `pg_dump` of the live database, every secret and a manifest. It is
  mode 600 and unencrypted, and documented as holding the master key.
- **Restore.** It requires api, worker, web and valkey to be stopped. It restores into a staging
  database in one transaction and swaps it in only on success, then puts the secrets back. The
  credential key files become exactly the backup's set, so a backup from before a key rotation
  restores with its own keys (ADR 0115).
- **Key rotation.** `docker compose run --rm credential-key rotate|retire|status` is a `tools`
  profile service on the app image, running as root to write the secrets volume (ADR 0115).
- **Upgrade.** Upgrades migrate in place on start. CI proves this by filling the previous release
  with data and starting the current commit on the same volumes (NF-O6).

### Release

- **Trigger.** [`release.yml`](.github/workflows/release.yml) runs on a `v*.*.*` tag.
- **Build.** It builds both images natively for amd64 and arm64 and pushes them by digest with
  provenance and SBOM.
- **Images.** `ghcr.io/lakka-ai/lakka` and `ghcr.io/lakka-ai/lakka-caddy`.
- **Checks.** It pulls the pushed bytes back and runs the scan, size budget, offline embedding
  with both classifiers and bundle smoke test on them.
- **Publish.** It then:
  - joins the digests into manifest lists;
  - signs them with cosign (keyless, GitHub OIDC);
  - builds a reproducible release bundle with every image pinned by digest
    ([`scripts/release-bundle.ts`](scripts/release-bundle.ts));
  - signs the bundle, and attaches it to a GitHub release.
- **Procedure.** See [`docs/releasing.md`](docs/releasing.md) (ADR 0086).

### The project site

The landing page and the operator guide are published as a static site (ADR 0119). VitePress 2,
pinned exactly, reads `docs/index.md` and `docs/guide/` in place, so the guide has one source
that renders on GitHub and on the site. Search is a local index built with the site, and the
fonts are the app's own `@fontsource` packages: nothing loads from a third party. The theme maps
the app's theme tokens onto VitePress's variables, and VitePress's search dialog is patched for
its roles and focus (ADR 0120). [`pages.yml`](.github/workflows/pages.yml) builds and deploys it
to GitHub Pages on a push to main that changes it; the base path comes from Pages, `/lakka/` by
default.

---

## Testing and CI

| Tier            | Command                                                      | What it runs against                                                                                                                                                            |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | `pnpm test`                                                  | No network, no services. Includes the import boundaries test                                                                                                                    |
| Integration     | `pnpm test:integration`                                      | Real Postgres (16 and 18 in CI) and Valkey in Testcontainers, one fresh database per test; a scriptable fake provider; MCP fixture servers; Dex and Keycloak for OIDC and OAuth |
| Out of process  | `pnpm test:out-of-process`                                   | A tool run through `lakka tool-runner` in a locked-down container of the app image                                                                                              |
| Sandbox         | `pnpm test:sandbox`                                          | A probe stdio server in the running stack's sandbox: what it can read, resolve and reach, its limits; the sandbox and the proxy stopped or killed under it (NF-S4)              |
| Pattern gallery | `pnpm test:stories`                                          | Every Storybook story in a browser, in light and dark, at 1280px and 390px; fails on an axe violation, a console error or sideways scroll                                       |
| Acceptance      | `pnpm test:e2e`                                              | Playwright against the full compose stack with the fake provider and Keycloak; axe accessibility checks on each page; fails on any console error                                |
| Compatibility   | `pnpm test:compat`, `test:compat:python`, `test:compat:apps` | The official TypeScript and Python OpenAI SDKs, and unmodified Open WebUI and LibreChat, against the stack                                                                      |
| Bundle          | `pnpm test:bundle`                                           | A release bundle: first run, cold start time, offline start                                                                                                                     |
| Upgrade         | `pnpm test:upgrade`                                          | The previous release filled with data, upgraded in place                                                                                                                        |
| Scan            | `pnpm scan`                                                  | Trivy on the lockfile and the images; a HIGH or CRITICAL with a fix fails                                                                                                       |
| Copy            | `pnpm check:copy`                                            | Banned characters in web UI and site text: non-ASCII, and `+` used as "and"                                                                                                     |
| Site            | `pnpm site:check`                                            | The built site: links and anchors, no third-party requests, every page at ten sizes in light and dark, menus, search and keyboard, in Chromium, WebKit and Firefox              |
| DCO             | `pnpm check:dco`                                             | Every commit in a range signed off by its author (ADR 0002)                                                                                                                     |

- **Budget tests.** The budget engine's failure-injection tests were written first. They run on real
  stores: 50 concurrent requests against room for 10, SIGKILL mid-stream, a Valkey flush, Postgres
  down, overage, client disconnect, nested caps, and period rollover.
- **Fake provider.** [`test/integration/fake-provider.ts`](test/integration/fake-provider.ts) picks
  its behaviour from the model name (`slow`, `status-429-ra2`, `drop-after-2`, `stall`,
  `tool-a.b`, and so on). The same fake runs in the e2e stack.

[CI](.github/workflows/ci.yml) runs eight jobs:

- `check`: typecheck, lint, workflow lint, format, the copy check, unit tests, the pattern gallery,
  and migrations in step with the schema;
- `dco`, on pull requests only;
- `site`, one leg per browser engine;
- `integration`, on Postgres 16 and 18;
- `out-of-process`;
- `image`, on amd64 and arm64: the embedding budget for both classifiers (MiniLM 100 ms p95 at one
  and two threads, mpnet 200 ms at two), routing evaluation in five languages for both, size,
  scan, and bundle smoke test;
- `upgrade`;
- `stack`, on amd64 and arm64: e2e, the compat suites, the stdio sandbox, the diagnostics bundle,
  backup and restore, and graceful shutdown.

`pnpm ci:local` runs the same jobs from a clean clone of `HEAD` on the host architecture (ADR 0065).
The M7 gate in [`docs/gates/m7.md`](docs/gates/m7.md) maps each of the 21 acceptance criteria to
the test that proves it, and the later gates in [`docs/gates/`](docs/gates) do the same for each
milestone's exit criteria.

---

## Where to find things

| To change...                             | Start in                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What happens to every model request      | [`packages/core/src/pipeline/handle.ts`](packages/core/src/pipeline/handle.ts)                                                                                                                                                                         |
| Tool rounds, approvals, continuations    | [`packages/core/src/pipeline/tool-loop.ts`](packages/core/src/pipeline/tool-loop.ts)                                                                                                                                                                   |
| Retries, failover, the commitment window | [`packages/core/src/gateway/dispatch.ts`](packages/core/src/gateway/dispatch.ts), [`commit.ts`](packages/core/src/gateway/commit.ts), [`classify.ts`](packages/core/src/gateway/classify.ts)                                                           |
| Reservations and the Lua scripts         | [`packages/core/src/budgets/engine.ts`](packages/core/src/budgets/engine.ts), [`maintenance.ts`](packages/core/src/budgets/maintenance.ts)                                                                                                             |
| The per-person rate limit                | [`packages/core/src/pipeline/rate-limit.ts`](packages/core/src/pipeline/rate-limit.ts)                                                                                                                                                                 |
| The resolution order                     | [`packages/core/src/routing/resolve.ts`](packages/core/src/routing/resolve.ts)                                                                                                                                                                         |
| What a route is scored from              | [`packages/core/src/routing/score.ts`](packages/core/src/routing/score.ts) (`scoringBasis`, `centroidStale`), [`compile.ts`](packages/core/src/routing/compile.ts)                                                                                     |
| Route example candidates                 | [`packages/core/src/routing/candidates.ts`](packages/core/src/routing/candidates.ts), [`packages/db/src/queries/routing.ts`](packages/db/src/queries/routing.ts)                                                                                       |
| Prices and the price feed                | [`packages/core/catalogue/models.json`](packages/core/catalogue/models.json), [`packages/core/src/models/`](packages/core/src/models)                                                                                                                  |
| Who may do what                          | [`packages/core/src/authz/policy.ts`](packages/core/src/authz/policy.ts)                                                                                                                                                                               |
| How a credential becomes a Principal     | [`packages/core/src/auth/authenticate.ts`](packages/core/src/auth/authenticate.ts)                                                                                                                                                                     |
| Credential keys and their rotation       | [`packages/core/src/credential-keys.ts`](packages/core/src/credential-keys.ts), [`packages/db/src/queries/credential-keys.ts`](packages/db/src/queries/credential-keys.ts), [`apps/api/src/cli/credential-key.ts`](apps/api/src/cli/credential-key.ts) |
| The tool dispatch stages                 | [`packages/core/src/tools/dispatch.ts`](packages/core/src/tools/dispatch.ts)                                                                                                                                                                           |
| MCP transports and OAuth                 | [`packages/core/src/mcp/`](packages/core/src/mcp)                                                                                                                                                                                                      |
| Where a tool runs                        | [`packages/core/src/tools/executor.ts`](packages/core/src/tools/executor.ts), [`sandbox.ts`](packages/core/src/tools/sandbox.ts), [`runner.ts`](packages/core/src/tools/runner.ts)                                                                     |
| The sandbox and the egress proxy         | [`apps/api/src/sandbox/`](apps/api/src/sandbox), [`packages/core/src/net/egress-proxy-policy.ts`](packages/core/src/net/egress-proxy-policy.ts)                                                                                                        |
| Where MCP traffic may go                 | [`packages/core/src/net/egress-policy.ts`](packages/core/src/net/egress-policy.ts), [`mcp/egress.ts`](packages/core/src/mcp/egress.ts)                                                                                                                 |
| The OpenAI wire format                   | [`apps/api/src/openai/`](apps/api/src/openai)                                                                                                                                                                                                          |
| An HTTP status for an error              | [`apps/api/src/server.ts`](apps/api/src/server.ts) (`STATUS_BY_CODE`), [`apps/api/src/openai/errors.ts`](apps/api/src/openai/errors.ts)                                                                                                                |
| A typed error                            | [`packages/contracts/src/errors.ts`](packages/contracts/src/errors.ts)                                                                                                                                                                                 |
| A table                                  | [`packages/db/src/schema/`](packages/db/src/schema), then `pnpm db:generate`                                                                                                                                                                           |
| What may be logged                       | [`packages/core/src/logger.ts`](packages/core/src/logger.ts) (`LOG_FIELDS`)                                                                                                                                                                            |
| What may be in a span                    | [`packages/core/src/gateway/telemetry.ts`](packages/core/src/gateway/telemetry.ts) (`STORED_ATTRIBUTES`)                                                                                                                                               |
| An environment variable                  | [`packages/core/src/config.ts`](packages/core/src/config.ts), and `docs/guide/configuration.md`                                                                                                                                                        |
| The compose stack                        | [`docker/compose.yaml`](docker/compose.yaml), [`docker/Caddyfile`](docker/Caddyfile)                                                                                                                                                                   |
| A shared UI pattern and its story        | [`apps/web/src/components/patterns/`](apps/web/src/components/patterns)                                                                                                                                                                                |
| Deleting a workspace                     | [`packages/core/src/workspaces/`](packages/core/src/workspaces), [`packages/db/src/queries/workspace-deletion.ts`](packages/db/src/queries/workspace-deletion.ts)                                                                                      |
| A provider kind                          | [`packages/contracts/src/gateway.ts`](packages/contracts/src/gateway.ts), [`packages/core/src/gateway/providers.ts`](packages/core/src/gateway/providers.ts), then a migration for the `provider_configs` checks                                       |
| The project site                         | [`apps/site/.vitepress/`](apps/site/.vitepress), [`docs/guide/`](docs/guide), [`test/site/`](test/site)                                                                                                                                                |
| A page                                   | [`apps/web/src/routes/`](apps/web/src/routes), data in [`apps/web/src/lib/queries.ts`](apps/web/src/lib/queries.ts)                                                                                                                                    |
