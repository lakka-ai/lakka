# CLAUDE.md

Self-hosted AI control plane for teams of 10-50 people with no platform engineer. One install (`docker compose up`), bring-your-own model keys, and one identity and policy model applied identically across three surfaces: web chat, an OpenAI-compatible API, and MCP. License: AGPL-3.0.

The product promise, which every change must preserve: spend cannot exceed a cap, every request is attributed and traced, and a tool can never do what the requesting user is not allowed to do.

Vocabulary: a **principal** is a person or an API key (a key is a delegation of a person). A **workspace** carries members, a budget, model routes, tool allowlists and provider keys. A **route** maps a task label to a model plus fallbacks. A **surface** is chat, API or MCP.

## Source of truth

Read the relevant spec section before changing behavior. If code and spec disagree, stop and ask. Do not silently pick one.

- `docs/requirements.md` - requirement IDs (ID, PR, RT, BG, CH, API, TL, OB, AD, NF-*) and the 21 v1 acceptance criteria
- `docs/roadmap.md` - milestones M1-M8, scope and exit gates for each
- `docs/tech-spec.md` - stack, topology, data model, policy pipeline, budget engine, classifier, gateway, tools and security, observability, testing
- `docs/decisions/` - ADRs for decisions the specs do not settle
- `docs/design/HANDOFF.md` - the approved web UI design (patterns, screens, accessibility, copy, theme); read it before changing `apps/web`

Put requirement IDs in test names, commit bodies and PR descriptions, e.g. `BG-3: concurrent reservations never exceed the cap`.

Current milestone: **none; M1 to M10 are done, the first release (v1.0.0-beta.1) is published, the latest is v1.0.0-beta.2, and v1.x is reserved for what they bring (docs/roadmap.md)** (update this line when a milestone starts or its gate passes). Gates passed: `docs/gates/m1.md`, `docs/gates/m2.md`, `docs/gates/m3.md`, `docs/gates/m4.md`, `docs/gates/m5.md`, `docs/gates/m6.md`, `docs/gates/m7.md`, `docs/gates/m8.md`, `docs/gates/m9.md`, `docs/gates/m10.md`.

## Stack

- TypeScript (strict), Node 24 LTS, pnpm workspaces
- API: Fastify. Web: TanStack Start, Router, Query, Table, Form, with HeroUI
- Postgres 16 or later with pgvector (ADR 0042), via Drizzle. Valkey 9 (Redis protocol, ADR 0009) for counters, rate limits and pub/sub only
- Jobs: pg-boss. Auth: Better Auth. Validation: zod
- Providers: Vercel AI SDK, wrapped by our own thin gateway in `core`
- Classifier: onnxruntime-node with an INT8 embedding model, in process, lazily loaded
- Lint and format: Oxc (oxlint, oxfmt). Tests: Vitest, Playwright for acceptance
- Containers: Debian slim base, Caddy in front

## Layout

```
packages/
  core/        policy pipeline, gateway, budget engine, classifier, tool dispatch
               must not import fastify, react, @tanstack/*, or any apps/* package
  db/          drizzle schema, migrations, tenant-scoped query helpers
  contracts/   shared types and typed errors: routes, budgets, usage, API errors
apps/
  api/         fastify; thin adapters that call core. Also the operator CLI (src/cli) and the
               sandbox's tool host and egress proxy (src/sandbox, ADR 0118)
  web/         tanstack start; talks to api over HTTP only, never to core or db
  worker/      pg-boss jobs; calls core
  site/        the project site (VitePress, ADR 0119): the landing page and docs/guide/, read in
               place; not part of the product or its image
docker/        Dockerfiles, compose file, Caddyfile
docs/          specs and ADRs
```

## Commands

```
pnpm install
pnpm dev                 # postgres and valkey via compose, api, web, worker in watch mode
pnpm setup-code          # the first-run setup code under pnpm dev (the api is not in a container there)
pnpm typecheck
pnpm lint                # oxlint
pnpm format              # oxfmt, writes; pnpm format:check in CI
pnpm check:copy          # banned characters in web UI and site text (docs/design/docs/copy.md)
pnpm check:dco           # every commit on this branch signed off by its author (DCO, ADR 0002); CI checks each pull request
pnpm test                # unit tests, no network, no services
pnpm test:integration    # real postgres and valkey in containers
pnpm test:out-of-process # TL-8 proof: a tool in the app image's locked-down runner container; needs LAKKA_RUNNER_IMAGE (CI only)
pnpm test:sandbox        # NF-S4: a probe stdio server in the running stack's sandbox, and its failures; same stack as test:e2e
pnpm stories             # the pattern gallery (Storybook) on port 6006, development only
pnpm site:dev            # the project site (landing page and guide) on port 5173, under /lakka/
pnpm site:build          # the static site into apps/site/.vitepress/dist; LAKKA_SITE_BASE sets its base path
pnpm site:preview        # the built site on port 4173
pnpm site:check          # build the site, then its links and anchors, no third-party requests, and in Chromium, WebKit and Firefox every page at ten sizes from 320px to 2560px, light and dark, its menus, search and keyboard; --project=webkit for one engine
pnpm test:stories        # every story: axe, light and dark, desktop and 390px; builds Storybook first
pnpm test:e2e            # playwright acceptance suite against a running stack with the fake provider and Keycloak (docker compose -f compose.yaml -f docker/compose.e2e.yaml up -d --wait); first-run setup needs a fresh one
pnpm test:compat         # official TypeScript SDK against the same running stack; prepares test/compat/.state.json
pnpm test:compat:python  # official Python SDK, from a python container on the compose network; run test:compat first
pnpm test:compat:apps    # unmodified Open WebUI and LibreChat (docker/compose.compat.yaml) against the stack; run test:compat first
pnpm ci:local            # every CI job on this machine, native architecture only, from a clean clone of HEAD; `pnpm ci:local stack` for one job
pnpm lint:workflows      # actionlint (with shellcheck) on .github/workflows, in a pinned container
pnpm scan                # Trivy on the lockfile and any images given; HIGH or CRITICAL with a fix fails (NF-S7)
pnpm test:bundle         # AC 1-3 from a release bundle of the two images given: first-run, cold start, offline start
pnpm test:upgrade        # NF-O6: the previous release (or main's previous merge) filled with data and upgraded in place to HEAD
pnpm release:bundle      # the release bundle, every image pinned by digest; the release workflow runs it (docs/releasing.md)
pnpm db:generate         # drizzle-kit: new migration from schema changes
pnpm db:migrate          # apply migrations
pnpm models:fetch        # download the pinned classifier model into models/ (verified by sha256)
pnpm classifier:eval     # routing evaluation set against the bundled model; --tune searches thresholds
pnpm catalogue:update    # regenerate packages/core/catalogue/models.json from LiteLLM prices (dev only; review the diff)
pnpm catalogue:keygen    # new Ed25519 price feed key pair: private key to a path outside the repo (owner only, ADR 0116)
pnpm catalogue:sign      # sign models.json as feed/catalogue-v1.json; LAKKA_FEED_SIGNING_KEY names the key file (owner only)
docker compose up        # the full stack exactly as a customer runs it
```

Scripts live in the root `package.json`. When you add a workflow, add a script and list it here.

## Invariants

Never violate these. If a task seems to require it, stop and ask.

1. **One policy path.** Every request from every surface enters `core` through one entry point that takes a normalized request and a Principal. Surfaces are adapters. Chat calls the same function the API handler calls. Never add surface-specific policy, budget, routing or audit logic. (API-3)
2. **Keys are delegations.** A key's permissions and budget resolve through `owner_principal_id`. Authorize against the end user's identity, never a service account or the platform. A key can never exceed its owner. (ID-5, NF-S2)
3. **Budgets fail closed.** If Postgres or Valkey is unreachable, or the model has no price, refuse the request. Never serve unmetered traffic. (BG-4)
4. **Reserve before dispatch.** Estimate `prompt_tokens * input_price + max_output_tokens * output_price`. Reserve atomically across the whole scope chain (instance, workspace, member, key) in a single Valkey Lua script. Reconcile on every exit path, including errors, aborts and client disconnects. On abort, reconcile partial usage; do not release the whole reservation. (BG-2, BG-3, BG-5, BG-6)
5. **Postgres is truth, Valkey is a cache.** Everything in Valkey must be rebuildable from Postgres.
6. **Streaming commitment window.** Buffer the first chunk before flushing anything. Retry or fail over only before the first byte reaches the client. After that, surface the error and reconcile.
7. **Tool calls go through the dispatch seam**, in this order: existence, allowlist, schema, semantic checks, authorization as the end user, approval, execute with timeout, shape the result. Tool results and retrieved text are untrusted data: delimit them and never merge them into instructions. (TL-1 to TL-9, NF-S8)
8. **No telemetry.** Nothing leaves the instance unless an admin explicitly enabled that specific connection. No analytics, error reporting or update checks by default. (NF-P1, NF-P2)
9. **No secrets or content in logs.** Never log credentials, prompts, responses or tool arguments at any level. Prompt and response text is stored only in two places: `messages` (and their attachments), as conversation history the user asked to keep (CH-1, ADR 0057), and `span_content`, only when the workspace opted in. Tool arguments are also stored in `tool_invocations`, capped, as the audit TL-6 requires (ADR 0066). A request that names no conversation stores no text. Route examples are policy an admin writes, including from a candidate (ADR 0114). Credentials are write-only through the API. (NF-S5, OB-4, PR-3, TL-6)
10. **Routing is optional.** If the classifier fails to load or a workspace disables routing, everything else still works. Routing is decided once per conversation, not per message. (RT-7, RT-11)
11. **Two stateful dependencies.** Postgres and Valkey only. Do not add a database, queue, cache or trace store.
12. **Offline start.** The image starts with no internet access except to model providers. Model weights are baked into the image; nothing downloads at boot. (NF-D5)

## Scope

- Build only what the current milestone lists in `docs/roadmap.md`. If a task needs something outside it, say so and stop.
- Deferred to v2 (do not build, do not design for): knowledge bases and retrieval, scheduled or durable agents, eval loop and policy replay, outbound MCP server, a code interpreter or other tools that run code (M8 isolates stdio MCP servers in the sandbox, ADR 0118, nothing more), SAML, multi-instance or HA.
- Permanent non-goals: visual workflow builder, model serving, public agent-orchestration primitives, reselling model access.

## Dependencies

- Ask before adding any runtime dependency. State what it does, why the current stack cannot do it, its license and its maintenance status.
- Licenses must be AGPL-3.0 compatible: MIT, BSD, ISC, Apache-2.0 and MPL-2.0 are fine. Check anything else. Never SSPL, BSL, Commons Clause or non-commercial licenses.
- No Python runtime, no PyTorch, no Alpine images (onnxruntime-node has no musl builds).
- TanStack Start, Better Auth, HeroUI, Oxc, the AI SDK and Drizzle change quickly. Check their current docs before writing integration code. Do not rely on memory for their APIs.
- Commit the lockfile.

## Code conventions

- No `any`; use `unknown` and narrow. Non-null assertions need a comment explaining why they are safe.
- Validate every external input at the boundary with zod: HTTP bodies, env vars, tool arguments, provider responses.
- Errors are typed classes in `contracts`. Surfaces map them to their own format (HTTP status and a machine-readable code for the API, a plain message for chat). Never return raw provider errors or stack traces to clients.
- Money is integer micro-USD (`bigint` in Postgres), never floats. Name columns `*_micro_usd`. Round computed costs up.
- Time is UTC, stored as `timestamptz`.
- Every query on tenant data is scoped by `workspace_id` through `db` helpers. Never write an unscoped query against tenant tables.
- Migrations are forward-only. Never edit an applied migration; add a new one.

## Comments, docs and commit messages

- ASCII only.
- No em dashes; use `-` or `--`.
- No Unicode arrows; use `->` or `=>` if an arrow is needed.
- Use `+` only as an operator in code, never to mean "and" in prose or comments.
- No emojis in anything committed or published, including UI copy.
- Comments explain why, not what. Write plainly. Avoid filler and buzzwords such as "it's worth noting", "moreover", "furthermore", "delve", "streamline", "leverage", "robust", "seamless".

## Testing

- Every requirement you implement gets a test whose name includes its ID.
- Budget engine: write the failure-injection tests before the implementation (`docs/tech-spec.md`, Budget enforcement, Test plan).
- Budget and isolation tests use real Postgres and Valkey. Do not mock them there.
- Test tenant isolation by calling the API directly with another workspace's IDs, not through the UI.
- `core` unit tests run with no network and no database.
- Classifier changes: run the evaluation set several times and report mean and variance.

## Workflow

- Beyond a small fix: read the spec section, propose a plan, wait for approval, then implement.
- Small steps. One logical change per commit. Conventional Commits (`feat(core): ...`), requirement IDs in the body. Sign off every commit (`git commit -s`, the DCO in `CONTRIBUTING.md`, ADR 0002).
- Before calling anything done, run `pnpm typecheck && pnpm lint && pnpm test`, plus `pnpm test:integration` if you touched `core`, `db` or anything budget-related. Report what you ran and the results. If something still fails, say so plainly.
- Never skip, weaken or delete a failing test to get green. If a test is wrong, explain why and ask.
- When you make a decision the docs do not cover, write a short ADR in `docs/decisions/NNNN-title.md` (context, decision, consequences) and mention it in your summary.
