# Technical Specification

*What we build and why, kept in step with the system as built. This is not an implementation guide: `ARCHITECTURE.md` maps the code. Decisions taken after the first draft are recorded as ADRs in `docs/decisions/` and cited where they apply. Where a decision is still open, it's marked as open rather than guessed.*

## Stack and topology

### Stack decisions

| Layer | Choice | Why, and what it replaces |
| --- | --- | --- |
| Language | TypeScript, strict | One language across API, worker and web; shared types for the policy contract. Node 24 runs the api and worker directly, with type stripping (ADR 0013) |
| API | Fastify | Thin adapters: they extract credentials and translate wire formats, and the policy pipeline lives in `core` (ADR 0020) |
| Web | TanStack Start, Router, Query, Table, Form | SSR React with a typed data layer; chat and admin are one app |
| UI | HeroUI | A component baseline with theming and accessibility already handled |
| Database | Postgres 16 or later, with pgvector | The single source of truth, including traces and usage. The compose file ships 18 (ADR 0010); pgvector is an extension, not another store (ADR 0042) |
| ORM | Drizzle | Typed schema and forward-only migrations in the same language |
| Cache | Valkey 9 | Budget counters, rate limits (sign-in windows and the per-person request bucket), revocation pub/sub; nothing durable. Rejected: Redis 7.4, licensed RSALv2 or SSPL (ADR 0009) |
| Provider layer | Vercel AI SDK provider packages | One interface for all providers, with streaming, tool calling and token accounting. Writing this ourselves would take months and wouldn't set us apart. We call the provider packages directly, not the `ai` package (ADR 0036) |
| Classifier | onnxruntime-node, INT8 embedding model | Runs in process, no network call. The bundled model is about 118 MB (ADR 0088). Rejected: PyTorch (image size) and a Python sidecar (a second runtime in the compose file) |
| Jobs | pg-boss | Backed by Postgres, so there's no third stateful dependency, and jobs are transactional with the data they touch. Rejected: BullMQ (needs Valkey durability we don't want to rely on) and Temporal (conflicts with a one-command install) |
| Auth | Better Auth | Sessions and OIDC, and it works natively with Drizzle. Rejected: writing our own |
| Proxy | Caddy | Automatic TLS matters for an operator without an ops team. nginx works too if preferred; the config is simple either way. Built from source onto Debian slim (ADR 0011, ADR 0086) |
| Lint and format | Oxc | Already in use; fast enough to run on every commit |
| Test | Vitest | Unit and integration tests; Playwright for the acceptance suite |

### Service topology

```
                 browser, OpenAI SDKs, Open WebUI, LibreChat
                                      |
                                      v
                    caddy (TLS, one origin, no buffering)
                                      |
               /api /v1 /healthz      |   everything else
             .------------------------'-------------------------.
             |                                                  |
             v                                                  v
   .-------------------.        HTTP only, cookie        .-------------.
   |        api        |<--------------------------------|     web     |
   |  Fastify adapters |                                 |  TanStack   |
   |                   |---> model providers             | Start (SSR) |
   |  core: pipeline,  |---> MCP servers (HTTP)          '-------------'
   |  gateway, budgets,|---> OTLP (only if enabled)
   |  classifier       |
   |  (ONNX, in proc)  |
   '---.-----------.---'                       .--------------.
       |           |                           |    worker    |
       v           v                           |   pg-boss    |
 .-----------. .------------.                  | budget sweep |
 | Postgres  | |   Valkey   |<-----------------| and rebuild  |
 | source of | | counters   |                  | alerts       |
 | truth and | | rate limits|                  | retention    |
 |  traces   | | pub/sub    |                  | partitions   |
 '-----.-----' '------------'                  | purge        |
       ^                                       | price feed   |
       |                                       '------.-------'
       '----------------------------------------------'

   api --- unix socket ---> sandbox: tool host, a runner and a stdio MCP server
                            |        per operation, each under a uid of its own
                            |        (internal network, no route out)
                            v
                          egress: proxy, signed token ---> listed origins only
```

Nine compose services: `init` (a one-shot job that generates missing secrets and the sandbox's keys, ADR 0004), `postgres`, `valkey`, `api`, `worker`, `web`, `caddy`, `sandbox` (the tool host stdio MCP servers run in) and `egress` (the sandbox's only way out). A `backup` service and a `credential-key` service sit under the `tools` profile, so `up` never starts them (ADR 0084, ADR 0115). Every Lakka process runs from one image with a subcommand; Caddy has its own (ADR 0014).

`web` stays a separate service. It mounts no secrets and reaches the api only over HTTP: the browser through the one origin Caddy gives both, and server rendering directly at `http://api:3000` (ADR 0006, ADR 0014). `sandbox` is on an internal network of its own with `egress`, and nothing else: the api reaches its tool host on a unix socket in a shared in-memory volume, so nothing in the sandbox can reach the api, Postgres or Valkey (ADR 0118). That needs Docker Engine 26 or later: older engines let a container on an internal network resolve outside names.

v1 has no MCP surface. Lakka is an MCP client, calling MCP servers as tools; serving MCP to outside clients is deferred to v2 with the outbound MCP server (ADR 0066).

### Package structure

The most important constraint, expressed as layout: **the policy pipeline and the gateway are a package, not middleware inside the HTTP app.**

```
packages/
  core/          policy pipeline, gateway, budget engine, classifier,
                 tool dispatch (no HTTP, no framework imports)
  db/            drizzle schema, migrations, tenant-scoped query helpers
  contracts/     shared types and typed errors: routes, budgets, usage,
                 API errors
apps/
  api/           fastify: thin adapters that call core; the lakka
                 CLI, the sandbox's tool host and the egress proxy
  web/           tanstack start: calls api over HTTP only
  worker/        pg-boss: calls into core
```

Because `core` has no framework dependency, the shared-path property can be tested on its own, and the chat surface can't quietly start reaching into internals. An oxlint rule and a boundary test enforce the layout: `core` imports no framework or app, and only `core` imports a provider SDK (ADR 0007, ADR 0036).

### Alternatives we rejected

**A separate Python service for the classifier.** The model ecosystem is better, but it adds a runtime, a container and an extra hop between processes on the critical path. That works against the deployment requirement, for a benefit we don't need at this model size.

**ClickHouse for traces.** The right answer at high volume, and the wrong answer for a third stateful dependency in a small-team compose file. Postgres with monthly partitions and retention handles the volume our target customers produce. ClickHouse is the documented way out if a customer outgrows it.

**A dedicated vector database.** Not needed. pgvector already stores route embeddings (ADR 0042), and is good enough for v2's knowledge features.

**Building our own provider layer.** We considered it because it's the layer we most want control over. We rejected it because the AI SDK absorbs provider changes, and a thin wrapper of our own on top of it keeps the control that matters (routing, cost, retries) without the maintenance. We use only the SDK's provider packages, one model call at a time. The `ai` package on top of them adds retries, tool loops, URL downloads and a hosted-gateway client that would sit underneath our own, so it isn't used (ADR 0036).

## Data model

This is a sketch, not DDL. The types are only indicative; what matters is the reasoning under each group. Every id is a UUIDv7 generated in the app (ADR 0027), money is integer micro-USD in `*_micro_usd` columns (ADR 0019), and time is `timestamptz`.

### Identity

```
principals       id, kind('user'|'key'), display_name, email?,
                 auth_subject?, owner_principal_id?, is_instance_admin,
                 status('active'|'suspended'|'deleted'), created_at
workspaces       id, name, slug, default_model?, pinned_model?,
                 routing_enabled, policy_version, content_capture,
                 content_retention_days, settings jsonb
memberships      principal_id, workspace_id, role('admin'|'member')
api_keys         id, principal_id, workspace_id, hash, prefix,
                 last_used_at, revoked_at
```

**`owner_principal_id` on a key principal is the critical column.** A key is a principal in its own right, so it can have its own budget and show up in audit records, but it points at the person who owns it, and authorisation goes through that link. A key can never have more permissions than its owner, because permission checks always follow the link back to the owner. This is requirement ID-5 expressed in the schema, and it's what makes NF-S2 true by design rather than something code review has to catch.

The database backs this up. Composite foreign keys onto `principals (id, kind)` make sure a key's owner is a person, never another key, and that only people are members (ADR 0027). `api_keys.hash` is a SHA-256 digest; the secret itself is stored nowhere (ADR 0030).

### Policy

```
routes           id, workspace_id, name, description, model,
                 fallbacks text[], allow_cross_provider,
                 threshold_down, threshold_up, enabled, signals text[]
route_examples   id, route_id, text, position, embedding vector,
                 embedding_model
route_centroids  route_id, embedding vector, embedding_model,
                 example_count, source('examples'|'description'|
                 'examples_and_description'), computed_at
route_candidate_decisions
                 message_id pk, workspace_id, decision('added'|
                 'dismissed'), route_id?, decided_by, decided_at
```

`route_candidate_decisions` keeps what an admin did with an overridden message offered as an example, never its text (see Capturing overrides, ADR 0114).

Centroids are computed and stored when a policy is saved, not on every request. The examples table keeps the original text so an admin can see and edit what the policy is built from. The policy has to stay readable, because an admin fixing a misroute is the whole improvement loop.

`threshold_down` and `threshold_up` are separate columns rather than one value. That puts the two-direction rule from RT-5 into the schema, so a later simplification can't quietly merge them. A check constraint keeps `threshold_down >= threshold_up`.

Embedding columns have no fixed dimension. Each row names the model that produced it, so a different embedding model (NF-A3) means recompiling, not a migration, and vectors from different models are never compared (ADR 0042, ADR 0043). pgvector is storage only: scoring is a dot product in memory over the policy snapshot.

`workspaces.policy_version` goes up in the same transaction as any write to routes, routing settings, budgets, tools or content capture. A cached policy snapshot checks it with one primary-key read (ADR 0042).

### Cost

```
provider_configs  id, workspace_id?, kind, name, base_url?, api_key,
                  last_test_status?
credential_keys   version pk, key_id (a fingerprint), created_at,
                  activated_at?, retired_at?       (instance-wide)
custom_models     id, model_ref, provider, model, context_window,
                  max_output_tokens, capabilities jsonb, input, output,
                  cache_read? and cache_write? prices per Mtok
catalogue_feed    enabled, envelope?, applied_serial?, last check and
                  its result, check_minute         (one row)
budgets           id, scope('instance'|'workspace'|'member'|'key'),
                  workspace_id?, principal_id?, limit_micro_usd,
                  period('daily'|'monthly'|'none'), alert_percents
budget_spend      budget_id, period_start, spent_micro_usd
reservations      id, request_id, workspace_id, principal_id,
                  acting_user_id, amount_micro_usd, actual_micro_usd?,
                  state, created_at, expires_at, settled_at?
reservation_lines reservation_id, budget_id, period_start
budget_alerts     id, budget_id, period_start, percent, state, attempts
alert_webhooks    id, workspace_id?, url, secret
usage             id, request_id, attempt, outcome, surface,
                  workspace_id, principal_id, acting_user_id, model,
                  provider, provider_config_id?, input, uncached input,
                  cache read, cache write, output and reasoning tokens,
                  usage_estimated, the four prices applied,
                  cost_micro_usd, finish_reason, latency_ms, ttft_ms,
                  resolution_rule, route_id?, route_confidence?,
                  default_reason?, was_overridden, overridden_model?,
                  budget_fallback_from?, created_at
```

Making `provider_configs.workspace_id` nullable gives us instance-wide credentials with workspace overrides (PR-8). A workspace credential is first-party at the standard address only; custom addresses and OpenAI-compatible endpoints are instance-wide and set by instance admins, so a workspace admin can't point the server into the customer's network (ADR 0038). `api_key` is encrypted at rest (see Secrets); `credential_keys` records which key versions exist and which is active, never a key (ADR 0115).

There is no price table. Prices come from a model catalogue that ships in the image, plus `custom_models` that instance admins add with prices entered by hand (PR-5, PR-7, ADR 0037), plus, when an instance admin opted in, the newest signed price feed, kept as fetched in the one-row `catalogue_feed` (PR-6, ADR 0116). **Each usage row stores a copy of the prices it was charged at** (ADR 0039). Re-pricing old usage at today's rates makes spend reports quietly wrong, and a buyer who notices that once stops trusting the dashboard; with the copy, a later catalogue update never changes past spend.

`usage` has one row per provider attempt that may have cost money, with its `outcome`: `completed`, `interrupted`, `aborted`, or `abandoned` for an attempt given up inside the commitment window (ADR 0039, ADR 0040). It has no foreign keys, because spend history must outlive deleted credentials, keys and workspaces.

`usage.resolution_rule` and `route_confidence` are the raw material for the override loop. Without them, an override tells you a user disagreed, but not with what. `overridden_model` keeps the model that lost, and `budget_fallback_from` the model a cap displaced (ADR 0047, ADR 0053). `surface` separates chat from API, which is how we show the single-policy property in reports and not just in code.

`budget_spend` keeps spend per cap and per period start, rather than one spent column on the budget (ADR 0049). A new period starts from zero by having no row yet, and a request is charged to the period it reserved in, through its `reservation_lines`.

`reservations` lives in Postgres even though the live counters are in Valkey. The budget section explains why.

### Tools

```
mcp_servers       id, workspace_id, name, transport('stdio'|
                  'streamable_http'), url?, command?, args,
                  auth_mode('none'|'shared'|'oauth'), allow_private,
                  egress_grandfathered, oauth_client?, oauth_scope?
mcp_allowed_origins
                  origin pk, source('admin'|'upgrade'), added_by?,
                  created_at                       (instance-wide)
mcp_credentials   id, mcp_server_id, principal_id, kind('shared'|'user'),
                  secret, refresh_secret?, expires_at?
mcp_oauth_states  state_hash, mcp_server_id, principal_id,
                  code_verifier, expires_at
workspace_tools   id, workspace_id, mcp_server_id, name, title?,
                  description?, input_schema, annotations, enabled,
                  approval_required, unusable_reason?
tool_approvals    id, conversation_id, request_id, principal_id,
                  workspace_tool_id, call_id, status, always,
                  decided_by_principal_id?, decided_at?
tool_grants       id, workspace_id, principal_id, workspace_tool_id,
                  granted_at, revoked_at?, revoked_by_principal_id?
tool_invocations  id, request_id, workspace_id, principal_id,
                  acting_user_id, conversation_id?, call_id, tool_name,
                  workspace_tool_id?, arguments jsonb, status, reason?,
                  credential_principal_id?, duration_ms, created_at
```

`mcp_credentials` is keyed on the combination of server and principal, and that pairing *is* TL-2. A server has one shared row, or one row per person who connected their own account, and partial unique indexes enforce both (ADR 0067). A schema with one credential per server would make per-user credentials impossible to add later without migrating every deployment.

`tool_invocations.credential_principal_id` records whose credentials were actually used. That differs from the principal who made the call when a server only supports a shared credential: it then names the admin who set that credential (ADR 0067). An auditor will ask about exactly that difference, so it's stored rather than worked out after the fact. `arguments` holds what the model sent, capped at 16 KB, because TL-6 asks for a full audit (ADR 0066).

`workspace_tools` holds tool definitions as they were when an admin last synced the server. The model is offered these stored definitions, never the server's live listing, so a server can't change what a trusted tool's description tells the model behind the admin's back (ADR 0069).

### Conversations and observability

```
conversations    id, workspace_id, principal_id, title, model_choice?,
                 route_id?, routed_model?, route_decided_at?
messages         id, conversation_id, workspace_id, role, content,
                 request_id, state, model?, routing_rule?, route_name?,
                 fallback_from?, tool_calls?, tool_call_id?, created_at
attachments      id, message_id, workspace_id, media_type, filename?,
                 size_bytes, data bytea
spans            trace_id, span_id, parent_span_id, workspace_id,
                 request_id, name, kind, status, error_type,
                 attributes jsonb, events jsonb, started_at, duration_ms
span_content     trace_id, span_id, workspace_id, request_id,
                 prompt jsonb, response jsonb, expires_at
```

`conversations.route_id`, `routed_model` and `route_decided_at` implement one routing decision per conversation (RT-7). The decision is stored on the conversation and isn't recalculated for each message. Deleting the route keeps the model, because switching models mid-conversation throws away the provider's prompt cache (ADR 0046). A conversation belongs to a person, never a key: one started through a key is its owner's (ADR 0047).

**Prompt and response text is stored in three places, each for its own reason** (ADR 0057, ADR 0066):

- `messages` and `attachments`, as conversation history the user asked the product to keep (CH-1). A request that names no conversation, such as a plain API call, stores no text. Attachments live in Postgres as `bytea`, because provider APIs keep no state, so a file is sent again on every later turn, and there's no other store to put it in.
- `span_content`, only when the workspace opted in.
- `tool_invocations.arguments`, as the tool audit.

Logs and spans never carry content.

**`span_content` is a separate table on purpose.** Content capture is off by default (OB-4) and has its own retention. Keeping it separate means retention enforcement is a delete on one table, a workspace that opts out writes nothing (rather than writing and then redacting), and the diagnostics bundle can include spans while leaving content out by design.

### Partitioning and retention

`spans` and `usage` are partitioned by month. A pg-boss job drops whole partitions that are past the retention window instead of deleting rows, then deletes the remainder in the one month the cutoff falls inside, so retention is exact (AC 21, ADR 0078). Dropping a partition is instant, while a bulk delete on a busy table is exactly the kind of thing that makes a small deployment look frozen. Partitions are created ahead of time, the current month and the next two, at startup and daily.

`span_content` is not partitioned. Each workspace sets its own content period, which whole months can't honour, so each row carries `expires_at` and is deleted by it (ADR 0077).

`usage` has a much longer default retention than `spans`. Spend history is what the buyer looks at over time, while trace detail loses its value quickly. The defaults are instance settings an admin can change (ADR 0075, ADR 0078):

| Data | Default |
| --- | --- |
| Spans | 30 days |
| Captured content | Its workspace's period: 1 to 90 days, 7 by default |
| Usage | 13 months |
| Conversations | Kept until deleted |
| Tool audit, decided approvals, revoked grants | 90 days |
| Budget alerts | 13 months |
| Closed reservations (settled, denied or abandoned) | 30 days |
| Expired MCP OAuth states and password reset links | Removed at the next run |

Conversations, traces and usage share one database, with separate retention for each. Budget counters are rebuilt from `budget_spend`, not from `usage`, so pruning usage never moves a cap.

## The policy pipeline

This is the one code path every request goes through, on every surface. It lives in `core` behind one entry point, `handleModelRequest`, which takes a normalised request and a Principal (ADR 0020, ADR 0047). Fastify only extracts the credential and translates the wire format. No surface can skip a stage, because no surface can reach a model except through that function: only `core` imports a provider SDK, and a boundary test enforces it.

### Stages

```
api          1. authenticate         -> Principal (person, or key -> owner)

core         2. resolve workspace    -> from the request, the key's scope,
                                        or the person's only workspace;
                                        authorise models.use
             3. load policy snapshot -> cached, versioned, invalidated on write
             4. rate limit           -> one token from the acting person's
                                        bucket in Valkey; or refuse
             5. resolve model        -> the resolution order (see Classifier)
             6. resolve tools        -> allowlist intersected with what the
                                        acting person can use
             7. estimate cost        -> prompt tokens * price, plus max output
             8. reserve budget       -> atomic; or fall back; or refuse
             9. dispatch             -> gateway, with the commitment window
            10. stream               -> events to the surface, which writes SSE
            11. reconcile            -> settle the reservation with recorded usage
            12. record               -> usage row per attempt, spans, and the
                                        conversation's turn and reply
```

### Notes on each stage

**Stage 1: key resolution follows the link to the owner.** An API key authenticates as its own principal for audit, but gets its permissions through `owner_principal_id`. Two things follow from that: revoking a person disables their keys automatically, and editing a key record can never give it more than its owner has. Nothing is cached, so revocation takes effect on the next request, and a live stream is ended within seconds (AC 6, ADR 0063).

**Stage 3: the policy snapshot doesn't change during a request.** Routes, routing settings, budgets, the tool allowlist and the content capture setting are read once, in one repeatable-read transaction, into a frozen object. Without this, a policy edit in the middle of a request could mean it's routed under one policy and billed under another. The snapshot is cached in memory, keyed by workspace and a version counter that goes up on any policy change, so the common case costs one primary-key read (ADR 0043, ADR 0049).

**Stage 4: the rate limit comes after access and before anything costs.** Each call to `handleModelRequest` takes one token from a token bucket kept in Valkey for the acting person, instance-wide, so a key draws on its owner's bucket (BG-12, invariant 2). After authorisation, so a caller who may not use models gets their 403 or 404 and drains nothing; before the conversation, routing and the reservation, so a refused request holds nothing, sends nothing and changes nothing. A tool loop's later rounds belong to the same call and take no token; an approval continuation is a new request and takes one. A refusal is `rate_limited`, HTTP 429 with `Retry-After`. The bucket expires once it would be full again, so a missing key is a full bucket and a flush only resets limits. `LAKKA_MODEL_REQUESTS_PER_MINUTE` (120) and `LAKKA_MODEL_REQUEST_BURST` (60) set it, and 0 per minute turns it off (ADR 0113).

**Stage 6: tools only where they can work.** A request is offered the workspace's tools only when it names a conversation and the resolved model can call tools. The list is the snapshot's enabled tools, less those on servers the acting person can't use right now, such as an OAuth server they haven't connected. A key sees its owner's list (ADR 0069, ADR 0071).

**Stage 7: estimates have to be pessimistic.** Reserve `prompt_tokens * input_price + max_output_tokens * output_price`. Reserving only the prompt cost would let one request with a long response go straight past a cap. Reserving too much gets refunded at stage 11; reserving too little is a breach. The promise only works in one direction. So prompt tokens are counted by an upper byte-based reading, each is priced at the dearer of the input and cache-write prices, the output limit is always sent to the provider, and a request reserves for the most expensive of its failover candidates (ADR 0050).

**Stage 8 is where the fallback happens, not stage 9.** If the reservation is refused because a cap has no room, the pipeline looks for a cheaper model that fits and reserves for that instead. Only if none fits is the request refused (see Budget enforcement, Fallback). Doing this before sending is what makes BG-7 possible; after sending, it's too late.

**Stage 9: the commitment window.** The gateway holds back the first chunk before sending anything to the client. Inside that window, a provider failure can be retried or failed over without the user noticing. Once a byte reaches the client, failover is no longer possible and the error has to be shown. This is also the only place where cheap output checks could run later.

**Stage 11 runs on every path, including errors and aborts.** A failed request still reserved budget. Reconciliation is guaranteed inside `core`, not by the HTTP framework's lifecycle: the stream's completion settles only after the reservation is settled, and a dispatch that fails before streaming settles before the error is rethrown. Settling never throws; if Postgres is unreachable, the worker's sweep settles it later (ADR 0020, ADR 0051).

**Tool rounds repeat stages 7 to 11.** In a tool loop, every model call after the first reserves for its own prompt and settles its own attempts, under the one request id (ADR 0071, ADR 0089).

### Where the surfaces differ, and where they're allowed to

The three surfaces only differ in transport and presentation. The MCP column describes Lakka serving MCP clients, which is deferred to v2 with the outbound MCP server (ADR 0066); in v1 Lakka is an MCP client only (M6).

|  | Chat | OpenAI API | MCP |
| --- | --- | --- | --- |
| Auth | session cookie | bearer key | session or key |
| Model selection | the conversation's choice, otherwise the resolution order | `model`: a model, `route/<name>`, or `auto` for the resolution order | the resolution order |
| Fallback | explained in the UI | `x-lakka-fallback-*` headers; a refusal is 402 `budget_exceeded` | protocol error |
| Everything else | *identical* | *identical* | *identical* |

What enforces this is that `core` exposes a single entry point that takes a normalised request and a principal, and the surfaces are adapters on top of it. Chat goes one step further: it is an ordinary client of the same `/v1/chat/completions` endpoint, with its session cookie, so there's one implementation with one caller (ADR 0057, ADR 0061). Inside `core`, the only difference is the `surface` value recorded on usage.

### Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Postgres unreachable | Refuse all requests with `budget_unavailable` (503). Fail closed, per BG-4 (ADR 0056) |
| Valkey unreachable | Refuse every model request with `budget_unavailable` (503): the rate limit can't be checked, and reservations can't be made atomically. This holds for a request no cap applies to as well; only with the rate limit turned off is such a request served (ADR 0050, ADR 0051, ADR 0113) |
| Classifier fails to load | Serve with routing turned off: requests fall to the default with the reason `classifier_unavailable`, and `/healthz` reports `degraded`. The load is retried a minute later. Routing is an enhancement, not a dependency (ADR 0043, ADR 0081) |
| Provider fails before the first chunk | Retry, then fail over according to policy |
| Provider fails after the first chunk | Show the error; reconcile partial usage |
| Process killed mid-stream | The reservation is orphaned; the worker charges what was recorded and releases it within the orphan window (ADR 0052) |

The Valkey row deserves a closer look, because it makes Valkey a hard availability dependency for a self-hosted product. The alternative (falling back to Postgres-only reservations when Valkey fails) can be built, but it adds a second code path through the most correctness-sensitive part of the system. For v1, refusing is the honest choice. Revisiting it is a reasonable v1.x item if operators find it painful.

## Budget enforcement

This is the most correctness-sensitive part of the system, because "never a surprise bill" is a marketing promise that has to hold up under concurrency, streaming and processes dying.

### How the work is split

**Postgres is the source of truth.** `budget_spend` holds the real number, per cap and period. Every settled request writes here.

**Valkey holds the live counter.** Each cap has one hash per period: a `spent` field and one field per outstanding hold. What is in use is spent plus the holds, so the check doesn't need to read Postgres.

The two will drift apart, and the design expects that rather than trying to prevent it. A counter can be rebuilt exactly from Postgres, and the worker regularly does so, so any difference corrects itself instead of quietly building up.

### Reservation

Checking and reserving has to be atomic across the whole chain of scopes, since a member cap sits inside a workspace cap, which sits inside an instance cap. A read followed by a write can't do this: ten concurrent requests would each see headroom that only one of them actually has.

The operation is a single Lua script run inside Valkey:

```
KEYS   = one counter per cap, outermost first (instance, workspace, member, key)
ARGV   = estimate, reservation_id, then each cap's limit and counter expiry

0. if any counter is missing -> return {missing}; seed it from Postgres, try again
1. for each key: in use = spent + every hold except this reservation's own
                 if in use + estimate > limit -> return {denied, innermost cap,
                                                          least headroom anywhere}
2. for each key: set the field r:{reservation_id} to the estimate
3. return {granted}
```

It's all-or-nothing across the chain, and Valkey runs it on a single thread, so two requests can never both pass the check by interleaving. Keeping each hold as its own field, rather than adding to one running total, makes every step safe to repeat and lets a counter be rebuilt exactly (ADR 0050).

A `reservations` row, with one `reservation_lines` row per cap and period, is written to Postgres as `pending` before the script runs and marked `active` after it. That puts two Postgres writes on the hot path of a capped request. We accept that, because a durable record written before the hold is what lets the worker rebuild counters exactly after a Valkey flush, and lets an operator answer "what was outstanding when this crashed?" If Postgres fails after Valkey granted the hold, the hold is released and the request refused. A request with no cap that applies is neither held nor recorded.

### Reconciliation

When a request completes, the actual cost is the sum of its usage rows, which the gateway priced from the token usage the provider reported:

```
actual = sum of cost_micro_usd over the request's attempts
1. in one Postgres transaction: claim the reservation if it is still pending
   or active, add actual to budget_spend for each line's own period, and
   record any alert threshold newly crossed
2. one Lua script: for each counter, if the hold r:{reservation_id} is still
   there, remove it and add actual to spent
```

Postgres is charged first. Settling twice charges once, because only a live reservation can be claimed. If Valkey fails at step 2, the stale hold only makes caps stricter until the next rebuild. If the hold is already gone, the counter was rebuilt after the charge and already includes it.

**Actual cost can be higher than the reservation**, though rarely. A provider might report more tokens than the maximum we planned for. The overage is recorded and allowed, since refusing after the work is done helps nobody. But it's logged as a budget anomaly (`budget.overage`), because if it keeps happening, the estimator is wrong.

### Orphans

A reservation can outlive its request when the process is killed mid-stream, when a client disconnects and cleanup doesn't run, or when Valkey is flushed.

- Every hold lasts 15 minutes, and every request is aborted after 10, so a live request always settles before its hold lapses (ADR 0051). A hold is a field in its counter with no expiry of its own, so something has to remove it.
- A worker job runs every 30 seconds under a Postgres advisory lock. It finds reservations past their expiry, charges what the request's usage rows recorded (less what its other reservations already charged, for a tool loop), marks them as abandoned in Postgres, and then releases their holds (ADR 0052, ADR 0089). The orphan window is the hold's lifetime plus one interval.
- A counter missing from Valkey, after a restart, a flush or at the start of a new period, is seeded from Postgres the moment a reservation needs it: spend for that period plus the holds of live reservations. The worker also rewrites every counter from Postgres at its start and every 5 minutes, keeping holds newer than its read, so drift corrects itself (ADR 0050, ADR 0052).
- One gap remains: the attempt that was streaming when the process died never recorded its usage, so what it cost is lost. The loss is bounded by one attempt per killed process (ADR 0052).

### Fallback

When a reservation is denied because a cap has no room, the pipeline tries cheaper options before refusing (ADR 0053):

```
1. candidates = the route's fallbacks, then the workspace default, without
   the refused model, each priced and estimated to fit the headroom the
   refusal reported
2. try them most capable first (by blended price); the first hold that
   succeeds is used, only that model may be dispatched, and the response
   carries a fallback notice
3. none fits -> refuse with the original budget_exceeded, naming the scope
```

The same rule applies whatever chose the model. For a model the user picked, a pinned model or the default, there are no route fallbacks, so the workspace default is the only candidate. A routed conversation keeps the model routing chose, not the one a cap forced, so the next message tries it again once there's room. The output limit is never lowered to make a request fit, since that would change what the caller asked for without telling them.

The notice matters as much as the mechanism. A user who silently gets a weaker model loses trust once they notice. One who's told *"your monthly budget is nearly used up, so this answer used the faster model"* usually accepts it. And a user who gets a raw error just stops using the product, which is the real failure. Chat says it in plain language; the API returns it in `x-lakka-fallback-from` and `x-lakka-fallback-scope` headers, and usage records it in `budget_fallback_from`.

### Streaming

Streaming complicates this in two ways, and both are handled in the gateway rather than here. Token counts are only final when the stream ends, so reconciliation can't happen earlier. And a stream that's cut off has still used tokens, so abort handlers have to reconcile with the partial usage rather than release the whole reservation.

A tool loop holds one round at a time. Each round after the first reserves for its own prompt, for the one model that answered the first round, with no fallback; a cap with no room ends the run and keeps what was done. Each round settles only its own attempts, on every exit, before the reply ends (ADR 0071, ADR 0089).

### Failing closed

BG-4 does the opposite of at least one well-known gateway, which skips budget checks when its database is unavailable and only logs a warning at startup. Our behaviour:

- Postgres unreachable: refuse. For a product sold on spend control, serving unmetered traffic is worse than downtime.
- Valkey unreachable: refuse every model request. Atomic reservation isn't possible, and neither is the per-person rate limit, which refuses the same way whether or not a cap applies. There is no fail-open path: one rule for everything that depends on Valkey. Only an operator who turns the rate limit off gets requests no cap applies to served without Valkey (ADR 0050, ADR 0113).
- No pricing known for a model: refuse with `unknown_model`. An instance admin can add the model with a price (PR-7). A model without a price can't be metered, and allowing it would open exactly the hole the product exists to close.

A store failure anywhere in the request path, from authentication to dispatch, becomes `budget_unavailable` (503), a clear and retryable error rather than a bare internal one (ADR 0056). A cap with no room is `budget_exceeded`, HTTP 402 and not 429, because the official SDKs retry 429s on their own (ADR 0057). The per-person rate limit answers 429 for that same reason: there, waiting and retrying is the right thing to do (ADR 0113).

This is a product decision as much as an engineering one, and it should be documented prominently. An operator who doesn't know about it will find their first Valkey outage very confusing.

### Test plan

This component gets failure-injection tests, written before the implementation:

| Scenario | Expected result |
| --- | --- |
| 50 concurrent requests, budget for 10 | At most 10 sent, no breach |
| SIGKILL mid-stream | Reservation released within the orphan window |
| Valkey flushed with reservations outstanding | Counter rebuilt correctly from Postgres |
| Postgres down | All requests refused, no partial state |
| Provider reports more tokens than estimated | Overage recorded, anomaly logged, no corruption |
| Client disconnects mid-stream | Partial usage reconciled, the rest released |
| Nested caps, member exhausted but workspace not | That member's requests refused, colleagues' go through |
| Period rollover during an in-flight request | Reservation honoured against the old period |

That last row is the subtle one. It's easy to get wrong and hard to notice: a monthly reset that lands between reservation and reconciliation must not count the spend twice or lose it. Each reservation line carries the period it reserved in, and is charged to that period.

## Classifier and routing

### Model choice

An INT8-quantised sentence embedding model in ONNX format, loaded in process through `onnxruntime-node` the first time an embedding is needed. In practice the first health check loads it, a few seconds after start (ADR 0081).

The bundled model is `paraphrase-multilingual-MiniLM-L12-v2`: 384 dimensions, trained on 50+ languages, about 118 MB on disk (ADR 0088). Its weights are its publisher's own INT8 ONNX export, one file per CPU family: arm64 for the arm64 image, AVX2 for the amd64 one, with the license text and a NOTICE beside them (ADR 0124). It replaced the English-only `all-MiniLM-L6-v2` (ADR 0022), which on German, French, Spanish and Swedish text sent about half of clearly typed messages to the wrong route. The multilingual model routes those languages with 77 to 82% accuracy, against 84% in English, and classifies a short message in about 5 ms on two CPUs. **The model is a configuration setting, not something fixed at build time** (`LAKKA_CLASSIFIER_MODEL_DIR`), as NF-A3 requires.

The image carries a second, larger model of the same family, `paraphrase-multilingual-mpnet-base-v2` (768 dimensions), which an operator can choose with that setting and two classifier threads (ADR 0123). It routes 80 to 87% of the evaluation set across the five languages, against 77 to 84% for the default, and classifies a long first message in about 65 ms on two CPUs with two threads on arm64, and about 105 ms on amd64 (p95 133 to 148 ms). CI holds it to 200 ms at two threads on both architectures, a budget of its own, because amd64 does not meet 100 ms. The default stays the smaller model, which meets the 100 ms budget at one thread. The embedder reads the vector size from the model, so either works without a code change.

A WASM build of the runtime (`onnxruntime-web`) remains a way out if we ever need an Alpine variant or a build with no native dependencies. It's 2 to 4 times slower, and it isn't shipped.

**Rejected: a small generative model.** A 0.6B model classifying through a prompt costs a model load, several hundred MB of memory, and 300 ms to 2 s on a CPU, only to do a worse job than a dot product does in 50 ms.

**Rejected: a decision model.** Jev-like models score a message against written options in one pass and return a probability for each (ADR 0121). The one that fits the latency budget, Decima-small, routes 74 to 79% of the English evaluation set from route descriptions, against 84% for centroids of twelve examples. Its options cannot take in examples, so it does not improve as admins add them, and it declines only through a "none" option, because its confidence is relative to the other options. The others measured were weaker or 4 to 6 times over the 100 ms budget.

### Compiling the policy

This happens when a policy is saved, not on every request:

```
for each route:
  embeddings = embed(each example phrasing not yet embedded by this model)
  described = embed("<name>: <description>") if the route has a description
  if the route has examples and a description:
    centroid = normalise(mean(embeddings and described)), source 'examples_and_description'
  else if it has examples:
    centroid = normalise(mean(embeddings)), source 'examples'
  else if it has a description:
    centroid = described, source 'description'
  store the centroid and the per-example embeddings
```

A route with no examples is scored from its name and description (RT-12, ADR 0122), at the route's own thresholds. Once it has examples, the description stays in its centroid with the weight of one example (ADR 0125). Editing a route's examples drops its centroid until the next compile, and so does editing its name or description when it has a description before or after, so a centroid never outlives the text it came from. A centroid made from something other than what the route has now, such as one compiled from examples alone before ADR 0125, is stale like one from another model, and is rebuilt the same way.

On the evaluation set, with one route described and six trained, the description alone raises accuracy 3 to 5 points in every measured language and lowers misroutes 2 to 3. With the description among the route's examples, a new route with one example scores 1.8 to 3.4 points above that example alone and 0.8 to 2.0 above the description alone, so a new route no longer gets worse at its first example. With twelve examples on every route and every route described, accuracy rises 0.1 to 1.3 points. CI fails, for either model, any of five languages and each of three description sets written blind, if the description alone does worse than no route, or if the description among a new route's 1, 2 or 4 examples, or every route's 12, does worse than the examples alone.

The per-example embeddings are kept next to the centroid, so nearest-example matching can replace nearest-centroid matching if evaluation shows it works better. Centroids blur a route whose examples fall into several distinct groups. The evaluation compared both: centroid matching is the default, and nearest-example matching scored clearly worse on our set, so it stays an evaluation option only (ADR 0045).

Every embedding records the model that produced it, by name and a hash of its weights. When the model changes, routes left behind score nothing, and one background recompile per workspace starts; the request in hand isn't held up (ADR 0043, ADR 0047).

### The resolution order

A fixed order, cheapest check first, and the first match wins (ADR 0046):

```
1. explicit user choice               -> a model, or route/<name> for that
                                         route's model, 'explicit'
2. conversation already routed        -> use it, record as 'sticky'
3. workspace pinned model             -> use it, record as 'pinned'
4. deterministic signal               -> code fence or source-file name,
                                         claimed by a route -> 'signal'
5. classifier above threshold         -> the route's model, 'classified'
6. workspace default                  -> 'default', with the reason
```

Steps 1 to 4 decide without touching the model. Step 5 only runs when they don't, and only on a latest user message of at least three words. If nothing chose a model and the workspace has no default, the request is refused with `no_model` rather than guessing.

The deterministic signals are a fixed list in code, published so the behaviour is predictable: `code_fence` (a line starting with three backticks or tildes) and `code_file` (a file name with a source-code extension). Each can be claimed by at most one route in a workspace, so a match is never ambiguous. Admins can't configure them; adding one is a release (ADR 0042, ADR 0046).

**Routing off** (RT-11) skips steps 2, 4 and 5. The user's own choice and the workspace pin still apply, because neither is routing. Skipping step 2 means turning routing off takes effect in existing conversations on their next message.

Failover comes only from a route. Signal, classified, sticky and explicit `route/<name>` decisions carry the route's fallbacks; an explicit model, a pinned model or the default has none.

### A threshold for each direction

Mistakes don't cost the same in both directions. Sending a hard task to a weak model gives a confidently wrong answer; sending an easy task to a strong model wastes money. So the threshold depends on whether the target is cheaper or pricier than the workspace default, by blended price, `(3 x input + output) / 4` per million tokens:

```
target cheaper than default  -> require similarity >= threshold_down (higher, 0.35)
target same or pricier       -> require similarity >= threshold_up   (lower, 0.30)
neither met                  -> fall back to default
```

If either price is unknown, the route counts as cheaper and needs the higher threshold, because the costly mistake is sending hard work to a weaker model (ADR 0046).

The defaults were measured against the evaluation set, not picked by intuition: tuned on half of 20 seeded splits and judged on the other half (ADR 0045, ADR 0088). The up threshold is the larger model's English-tuned value, and one default serves both models, so a route's thresholds do not depend on which one is loaded (ADR 0123). The first draft's starting values, around 0.75 and 0.55, are far above what these models produce for a message against a centroid, and sent nearly everything to "not sure". Thresholds are stored per route, so an admin can tighten a route that misbehaves without affecting the others.

**"Not sure" is a valid result.** A classifier that's allowed to decline can be mediocre and still help overall. One that's forced to always decide can't.

### One decision per conversation

Classification happens on the first message that can be judged, and the result is stored on the conversation record. It doesn't run again for each message.

There are two reasons, and people usually miss the second one:

1. Short follow-ups carry no signal. *"Make it shorter"* can't be classified without context, and embedding the whole history drifts towards whatever takes up most of it.
2. **Switching models mid-conversation throws away the provider's prompt cache.** The whole accumulated context gets sent again at full price. A router that switches models three times in one conversation can cost more than never routing at all, which would make the feature actively harmful while looking like it works.

A conversation remembers a signal decision, a classified decision, and a considered "not sure" (the classifier ran and declined). It doesn't remember a default reached because the message was too short or the classifier was unavailable, since nothing was judged yet. Explicit and pinned choices are re-evaluated on every request (ADR 0046).

It's only re-evaluated on an explicit signal: the user starting a new conversation, or overriding the route, which clears it.

### Capturing overrides

When a user picks a different model in a routed conversation (ADR 0047):

```
1. record the request as 'explicit' with usage.was_overridden, keeping
   the route that lost in route_id and its model in overridden_model
2. clear the conversation's stored route
```

No message text is stored for an override. That keeps overrides within invariant 9: text lives only in conversation history, opted-in content capture and the tool audit.

This produces the admin suggestion from RT-10. For each route people overrode, the routing page shows how many requests the route decided and people kept, how many they overrode, how many overrides went to a pricier model and how many to a cheaper one, the model chosen most often, and an estimate of what switching the route to it would cost (ADR 0048). After a budget fallback, the model people chose is the one in `budget_fallback_from`. Changing the route's model is one edit on the same page.

While the workspace records content, the page also offers the overridden messages as route example candidates (ADR 0114). A candidate is derived when it is read, never copied:

```
1. each override in the period: the losing route, and the chosen model
2. -> the override's turn in messages, by request id
3. -> the conversation's latest earlier user message whose request was
      decided by 'signal' or 'classified'
4. keep it if that decision was 'classified' for the losing route: it is
   the text routing judged (a signal decision offers nothing)
5. keep it while capture is on, the deciding request has unexpired
   span_content, and no admin has added or dismissed it
```

Candidates are grouped by losing route and chosen model, at most 20 per group, newest first. Deleting the conversation or the person, conversation retention and capture expiry each remove a candidate with its sources; turning capture off hides them all at once. `route_candidate_decisions` keeps only what an admin did with one (`added` or `dismissed`, the route, who, when), with no text. An admin may add a candidate to any route but the losing one, editing it first; the route save writes the examples and the decision in one transaction and recompiles, or refuses with `candidate_gone` if the candidate went meanwhile. Nothing is added automatically. An example added this way is policy the admin wrote, and stays until it is removed.

This is the override loop. Its quality depends entirely on how accurate `resolution_rule` and `route_confidence` are in the usage record. If those are approximated, the suggestions are just noise.

### Performance and caching

An LRU cache of 1,000 query embeddings, keyed by the text with whitespace collapsed, handles repeated phrasings. It lives in memory only; the text is never stored or logged. Classification is skipped completely for messages of fewer than three words, which don't carry enough signal. Target: p95 under 100 ms and under 5% of time to first token, as set in the performance limits. CI times a whole classification inside the image with two CPUs, on both architectures, and fails above 100 ms at p95 (ADR 0043); the larger model an operator can choose fails above 200 ms (ADR 0123).

### Shared use

The same runtime and model will also serve v2 retrieval, reranking (as a cross-encoder), semantic deduplication and topic-shift detection. Paying for the container space once is intentional, and it keeps the extra cost of the v2 knowledge feature small.

## Provider gateway

### Layers

The AI SDK's provider packages handle the differences between providers: message formats, tool schemas, streaming event types and stop reasons. Our gateway is a thin layer on top that owns what they don't: finding the right credentials, checking capabilities, classifying errors for retries, failover policy, the commitment window, and cost accounting (ADR 0036, ADR 0040).

Keeping it thin is a deliberate constraint. The SDK absorbs provider changes, and every bit of provider-specific handling we add is maintenance we've signed up for. API keys and base URLs are always passed explicitly, so the SDK never reads a provider's own environment variables.

```
pipeline -> gateway.dispatch(request, candidates)
             |- for each candidate: resolve credentials (workspace -> instance),
             |  check price and capabilities (vision? PDF? tools? context length?)
             |- attempt(model)
             |    |- commitment window: buffer first chunk
             |    |- on failure before commit -> classify -> retry / failover
             |    '- on failure after commit  -> surface
             '- every attempt that may have cost money -> usage row
```

### Capability checks

Every model in the catalogue, and every custom model, has a capability description: context window, maximum output, vision, PDF, tools, structured output, prompt caching and reasoning. The gateway checks these before sending, instead of finding out mid-stream.

This matters most for routing. A route might choose a model that can't handle the request's attachments. The right behaviour is to move on to the next capable option and record why, not to send the request and fail. A skipped candidate is recorded as an event on the dispatch span.

### Error classification

This is what decides whether a retry helps or just wastes budget (ADR 0040). Each model gets two attempts:

| Condition | Action |
| --- | --- |
| 429 rate limit | Retry the same model after `Retry-After`; if that's over 10 s, fail over |
| 5xx or 529 overload, an empty stream, a dropped connection | Retry with exponential backoff and full jitter, then fail over |
| No first chunk in time (30 s, or 180 s for reasoning models) | Retry, then fail over |
| 400 schema, or any other 4xx | Terminal: `provider_rejected_request`; the request is malformed |
| 401 / 403 | Terminal; show the admin a credential problem (`provider_auth_failed`) |
| Content filter | Terminal; never retry, never fail over |
| Context overflow, or a model the provider doesn't know | Don't retry; fail over at once. If nothing is left after an overflow, `context_too_long`; after an unknown model, `upstream_unavailable` |

Jitter isn't optional. If every client retries at the same moment after a provider hiccup, the wave of retries makes the outage last longer.

Provider error text can echo the request, so it's matched against patterns but never logged or returned. Surfaces see only our typed errors.

### The commitment window

The single most important behaviour in this component.

```
stream = provider.stream(request)
first  = await withTimeout(stream.next(), COMMIT_WINDOW_MS)

if (error before first chunk)  -> retry or fail over without the user noticing
if (first chunk received)      -> flush; from here on, failover is impossible
```

Once a byte reaches the client, the response is committed. A provider failure after that has to show up as an error, because switching providers mid-stream produces output that doesn't make sense. This limits the retry policy, not the other way round.

HTTP headers are part of the window: nothing is written, not even the status line, until a first chunk exists. A request that never commits gets an ordinary JSON error with a real status code; one that fails after commit gets an error event inside the stream (ADR 0025). In a tool loop the window covers the response's first byte, and a later round that fails before its own first chunk may still retry (ADR 0066).

The window is also the only place where cheap output checks could run later without adding noticeable latency.

### Failover scope

Fallbacks are set per route, in order, and default to **the same model family first**. Prompts tuned for one model family often do worse on another, and a fallback that quietly lowers quality is worse than a visible error for some uses. The provider stands for the family: fallbacks from another provider are dropped unless the route allows crossing providers (`allow_cross_provider`), and saving a route without that flag refuses them. The trade-off is explained where the admin sets it up (ADR 0040, ADR 0042).

After a budget fallback, only the model the reservation was sized for may be tried.

### Cost accounting

Cost is calculated from the token usage the provider reported, at the prices the model has when the request runs, and those prices are copied onto the usage row (ADR 0039):

```
cost = ceil(( uncached_input * input_price
            + cache_read     * cache_read_price
            + cache_write    * cache_write_price
            + output         * output_price ) / 1e6)
```

Prices are integer micro-USD per million tokens, and the sum is divided once and rounded up. Cached tokens are counted separately because their price is quite different, and a system that ignores them overstates spend. That undermines trust in the dashboard, which is the main thing the buyer looks at. A long-context price tier applies to the whole call once its input passes the tier's threshold, as the providers bill it.

Missing figures are filled in pessimistically. A missing cache price bills those tokens at the input price. A token count the provider didn't report is taken from the upper estimate and the row is marked `usage_estimated`; a reasoning model that reports no output count is charged its full output limit.

**The model catalogue is something we maintain.** It ships in the image as a committed file, regenerated from LiteLLM's price list at a pinned commit and reviewed in the pull request, because it changes what requests are billed (PR-5, ADR 0037). Each regeneration raises the file's `serial`. A model with no known price is refused rather than served unmetered, per BG-4.

**Prices between releases come from a signed feed an admin opts into** (PR-6, ADR 0116). The owner signs the bundled file as `feed/catalogue-v1.json` with an offline Ed25519 key; the public keys, a primary and a backup, are baked into core; a build without them cannot turn the feed on. The feed is off by default and an instance admin turns it on, on the Models page; `LAKKA_CATALOGUE_FEED_URL` points at a mirror, or `off` locks it off. While it is off the worker's job contacts nothing (NF-P2). On, the worker fetches it once a day at the instance's own minute, or when an admin presses Check now: https only, no redirects, 10 s, at most 1 MB, and only `user-agent: lakka`. A feed applies only if its signature checks against a baked-in key and its serial is above both the release's and the last one applied. Even signed, it is refused whole for a provider that is not first-party, a zero price, a tier that lowers a price, more than 2000 models, or a cut below a quarter of a bundled price. It never removes a model; bundled ids take its prices, and models only it lists rank below custom models. The worker stores it in one transaction; the api polls the row every 30 s, verifies the stored file again on every load and ignores one that fails, so a feed never blocks startup. Each request pins the catalogue it started with, so its reservation, dispatch and usage rows use the same prices (invariant 4).

### Streaming transport

SSE from Fastify, with three details that are easy to get wrong:

- Response buffering has to be turned off at the reverse proxy, or streaming looks broken in a way that's maddening to debug. This belongs in the Caddy configuration we ship, not just in the documentation: Caddy proxies the api with `flush_interval -1` and no compression, and responses also send `X-Accel-Buffering: no` for customers' own nginx-style proxies.
- An inactivity timeout, separate from the overall request timeout: 60 s without a chunk, or 180 s for reasoning models, ends a committed stream as interrupted. Otherwise a stream that opens and then stalls would hang until the overall timeout, which is far too long.
- A client disconnect has to trigger reconciliation with the partial usage, not release the whole reservation. The tokens were used.

### Idempotency

Providers offer no idempotency keys for generation. A request that timed out on our side may still have completed on the provider's side, so a retry can bill twice. We retry anyway inside the commitment window, and the record says so: an attempt that failed after the provider may have started generating is recorded as `abandoned` and charged (ADR 0040).

Tools are where running twice does real harm, so the tool layer never sends a call that may have run a second time. A tool call is retried only when its server couldn't be reached and the tool says repeating it is harmless (ADR 0070).

## Tools, MCP and the security model

### MCP servers

Lakka connects to MCP servers over stdio and Streamable HTTP (TL-1). A stdio server runs a command in the `sandbox` container, so only instance admins may add one, and the command must already be in the image or a volume mounted there (ADR 0118). Workspace admins add HTTP servers, which must be public https unless an operator lists their origin as private-allowed (ADR 0066, ADR 0067).

Whoever adds it, an HTTP server's origin must be on the instance's allowlist, `mcp_allowed_origins`, which only instance admins change; the origins in `LAKKA_MCP_PRIVATE_ORIGINS` count as listed (NF-S4, ADR 0117). One pure function, `decideEgress` in core's `net/egress-policy.ts`, decides every request: the origin must be listed, and it may resolve to a private address only for an instance admin's server or an origin the operator listed as private. The guarded fetch applies it to every request to an MCP server and its authorization server, resolves names to public addresses only at connection time where the rule says so, and never follows a redirect. The list is read from Postgres on every connection: saving a server, testing, syncing, connecting an account, refreshing a token and every tool call. An OAuth server's authorization server, issuer, and token, registration and authorization endpoints must all be listed. Servers that existed before the list were listed by the upgrade, and an OAuth one lists the origins its metadata names the first time they are discovered. A stdio server keeps to the same list through the egress proxy, which calls the same function (ADR 0118, below). What a remote server does after Lakka calls it is outside Lakka's control.

An admin syncs a server to make its tools known. Every tool starts off the allowlist (TL-3). A tool the server marks read-only needs no approval by default; every other tool asks first. The server's annotations are hints: they set defaults and never override an admin (ADR 0069).

### Dispatch

Between the model asking for a tool call and any code running, checks happen in a fixed order. Each one is cheap, and skipping any of them is how security gets lost.

```
1. existence        -> unknown name -> error result listing valid tools
2. allowlist        -> was the tool offered to this request?
3. schema           -> validate arguments against the declared schema
4. semantic         -> cross-tenant ids, impossible ranges, etc.
5. authorisation    -> the server's origin is allowed (NF-S4), then
                       against the END USER's identity, never ours
6. approval         -> ask if required and not already standing-approved
7. execute          -> under a timeout, through the dispatch layer
8. shape            -> trim the result down before it enters context
```

Step 5 matters most, and it's the one convenience wears away. A key resolves to its owner, and the owner's permissions limit everything. NF-S2 belongs in code review criteria, not only in a requirements table.

Arguments must be an object of at most 16 KB. Lakka knows nothing of an MCP tool's meaning, so its semantic check is structural only; built-in tools will add their own there. A call runs under a 30-second timeout. Every call the model asks for is audited in `tool_invocations`, whatever became of it, with whose credential was used (TL-6, ADR 0070).

### Per-user credentials

TL-2 is what sets our security apart, and it lives in the `(mcp_server_id, principal_id)` key on the credential table. Where a server supports OAuth, each user authorises separately and the server sees *them*. Lakka follows the MCP authorization spec: discovery from the server, dynamic client registration where offered (or a client an admin registers), PKCE, and a token bound to the MCP server as its resource. Tokens are refreshed under a row lock, and a refused refresh deletes the token so the person connects again (ADR 0068).

Where a server only supports a shared credential, we fall back to that, but we record `credential_principal_id` on every call. That way the audit trail shows the difference honestly, instead of implying an isolation that isn't there. Make this explicit in the UI too: an admin setting up a shared-credential server should see what they're agreeing to.

### Approval

An approval request ends the current run instead of blocking it. The response carries a pending approval (`lakka.pending_approval`, the one non-standard field in the API's body); the client collects the answer and sends a continuation, a request in the same conversation with `x-lakka-approve` or `x-lakka-deny`. This approach survives the process dying, load balancing, and the user closing the tab. A blocking implementation doesn't. Only the principal whose request made the call can answer it (AC 18, ADR 0066, ADR 0071).

Standing approvals apply per principal per tool, can be revoked by both the user and the admin, and are recorded with a timestamp, so "why did this run without asking?" always has an answer. Only a person can grant one. A key approves one call at a time, and doesn't inherit its owner's standing approvals (TL-5, ADR 0071).

### The execution layer

Every operation on an MCP server, a tool call or listing its tools to test or sync it, goes through a `ToolExecutor` that takes plain data (TL-8, ADR 0070). The api runs HTTP servers itself, through the guarded fetch, and sends every stdio operation to the sandbox (NF-S4, ADR 0118):

- **The tool host** (`lakka tool-host`, the `sandbox` service) takes one runner request per operation over a unix socket, with a bearer token only the api and the sandbox have. It starts a fresh `lakka tool-runner` for it in a free slot: a uid of its own from 61000 up, a home on the container's tmpfs, and limits of 64 processes, 512 MB of data, 120 s of CPU, 256 files and 64 MB per file. The runner starts the stdio server as its child, under the same uid, and the tool host passes the runner's reply back without reading it. After the operation, or when the api goes away, everything the uid owns is killed and its home emptied; a slot that cannot be cleaned is taken out of use. An operation waits for a slot until its deadline, then fails as unreachable.
- **The container** is root only to switch uids: every capability is dropped but SETUID and SETGID, `no-new-privileges`, a read-only root, and limits for all slots together. It mounts no secrets.
- **The egress proxy** (`lakka egress`) is the sandbox's only way out. The api makes a token for each operation, HMAC-signed over the server's rule (the instance's allowlist, the operator's private origins) with an expiry of at most 45 s, and the runner gives the server `HTTPS_PROXY` and `HTTP_PROXY` with the token, and `NODE_USE_ENV_PROXY=1`. The proxy decides with `decideEgress`, never reaches Lakka's own services or itself, resolves names itself and keeps no state. A process that ignores the proxy settings has no network: the sandbox's network is internal, and Docker Engine 26 and later resolve no outside names there.
- **The runner protocol is version 3:** `op: call | list`, the operation, and the proxy URL. Each call carries the origins it may reach (ADR 0117). A runner refuses any other version (ADR 0073, ADR 0118).

When the sandbox is down, stdio operations fail closed as `unreachable`, and nothing else is affected. `pnpm dev` runs stdio servers in the api (`LAKKA_TOOL_HOST_URL=in-process`), with a warning; the production image refuses that setting. `pnpm test:sandbox` proves the isolation in the running stack, and `pnpm test:out-of-process` runs a tool in a container with no network at all.

The seam was the only deliberate over-engineering in v1, because security boundaries can't be added convincingly later: the sandbox (M8) changed no dispatch check. Node's `vm` module is not a security boundary and isn't an option. A code interpreter, or any built-in tool that runs code, stays in v2.

### Prompt injection

The most underrated risk in an agent product, and the reason this category has seen host code-execution, SSRF and cross-user credential failures in comparable products.

The model can't reliably tell content it was asked to read apart from instructions it was asked to follow. So the defences have to be structural, not written into the prompt:

- **Tool results are marked as data** with clear framing, and never mixed into the instructions (NF-S8). They reach the model only as tool messages, inside `<tool_result>` delimiters that are escaped within the result, so a result can't close its own frame (ADR 0070).
- **Authorisation doesn't depend on the model's decisions.** A successful injection can only reach what the user could already reach, which is why step 5 above can't be negotiated away.
- **Approval steps for anything that sends data out, deletes, or spends money**, because the dangerous combination is untrusted input plus a tool that can send data outward.
- **Outbound allowlists** for anything that makes network requests. Every MCP request, an OAuth one included, goes to an origin an instance admin listed, through a fetch that also refuses private addresses at connection time where the server must be public, and never follows redirects (ADR 0067, ADR 0117). Webhooks keep their own public-only rule (ADR 0054).

Prompt instructions telling the model to ignore embedded instructions are worth including, but they're not something to rely on. If the design depends on them, the design is wrong.

### Shaping errors

A tool failure usually isn't a run failure. Returning a short, plain-language error lets the model correct itself. What goes back matters:

```
Bad:  psycopg2.errors.UndefinedColumn: column "cust_email" does not exist
Good: Unknown field 'cust_email'. Valid fields: email, order_id, status.
```

The first one leaks internals, costs tokens, and usually just leads to another guess. Tell apart the errors the runtime can retry (temporary problems: retry quietly), the errors the model can fix (a bad argument: show it), and terminal errors (permission denied: show it and stop, and never let the model probe for variations that might work).

Guard against loops: at most 8 rounds of tool calls per request (TL-9), a tool set aside after 3 consecutive failures or one terminal failure, and a repeated identical call ending the loop, since it means the model is stuck rather than making progress. When the loop stops early, the model answers once more without tools, so the person still gets an answer (ADR 0066, ADR 0071).

### Shaping results

Tool output goes straight into context, so returning a raw API response is usually a mistake. Cut it down to what's needed, truncate long lists with a clear note, and prefer compact formats over deeply nested JSON. For MCP tools, text is kept, binary content is named but not forwarded, and the result is cut at 16 KB with a note (ADR 0070).

### Secrets

Credentials are encrypted at rest with AES-256-GCM under a master key from the environment or the secrets volume, with the column's name bound in, so a ciphertext copied into another column fails to decrypt. The master key is never stored next to the ciphertext. Per-record data keys were not adopted: with the master key in the environment, wrapping per-record keys under it adds no protection, only another layer to get wrong. The stored format's version prefix names the key a value was encrypted with (ADR 0032, ADR 0038).

The master key can be rotated (NF-S9, ADR 0115). Keys are numbered: v1 is the original `credential_master_key`, later ones are `credential_master_key_v<N>` in the same volume, or all of them in `LAKKA_CREDENTIAL_KEYS`. Values are decrypted with the key their prefix names and written with the active one. Postgres records each version with an HMAC fingerprint and which one is active, never a key, so every process refuses to start without the active key or with a wrong one. Rotation is offline and one-shot: with the api and the worker stopped, `docker compose run --rm credential-key rotate` writes the next key file first, then in one transaction re-encrypts every encrypted column, found from a registry the column type fills, and activates the new version. A crash at any point is safe to rerun. `retire` removes older keys only once no stored value needs them. Backups carry their keys, and restore makes the key files exactly the backup's, so an older backup restores with its own key. The new recovery key is read with `docker compose exec api lakka recovery-key`. Better Auth encrypts OAuth access and refresh tokens with the auth secret, which this does not rotate.

Credentials are write-only through the API: never returned, never logged, never in the diagnostics bundle (PR-3, NF-S5). The diagnostics bundle is built by listing what goes in, not by redacting what shouldn't (ADR 0083). Redaction fails open; an allowlist fails closed.

## Observability, deployment and testing

### Tracing

OpenTelemetry's trace SDK, following the GenAI semantic conventions, so traces work in any customer's existing backend without adapters. Core owns its tracer provider and never registers it globally, so libraries that speak the OpenTelemetry API, such as Better Auth and Drizzle, can't emit spans carrying SQL or emails (ADR 0041, ADR 0076). The span tree:

```
request                       surface, principal, acting user, outcome
 |- policy.authorize          access, and the policy snapshot
 |- policy.rate_limit         the wait, when refused
 |- policy.resolve_model      route, rule, confidence, signal, reason
 |- policy.reserve_budget     caps, estimate, refusing scope, fallback
 |- gateway.dispatch          candidates skipped, attempts, cost
 |   '- chat <model>          one per attempt: tokens in/out/cached,
 |                            cost, ttft, finish reason
 |- execute_tool              tool, status, credential principal
 '- policy.reconcile          reserved, actual, delta (one per round)
```

The custom `policy.*` spans are the ones no generic backend would give us, and they're what make the override loop and the budget behaviour debuggable.

Only attribute names on an allowlist are stored or exported, so content can't reach the trace store through a span, whoever made it (AC 20, ADR 0076). A span that fails to write is dropped and logged; a trace is never worth failing a request for.

**Content capture is off by default** (OB-4), and when it's on, content goes into the separate `span_content` table with its own retention, 1 to 90 days. This makes debugging harder, on purpose: the default protects a customer who hasn't thought about it, and the opt-in is there for one who has. It's shown on the workspace page to everyone in the workspace, on or off, and chat says it's on while it is, because an operator who doesn't know content is missing will misread their first quality problem. Only workspace and instance admins can change it, never through a key, and the change is logged (ADR 0077).

**The default exporter writes to Postgres.** OTLP export is available for customers with their own backend, switched on only by setting `LAKKA_OTLP_ENDPOINT`. The standard `OTEL_*` variables are ignored, so a platform that injects them can't start sending a customer's traces somewhere, and captured content is never exported. There's no external dependency in the default setup (OB-3, OB-5, NF-P1, ADR 0080).

### Metrics to have from day one

Beyond latency and error rate: cost per request and per principal, with alerts when spend crosses a cap's thresholds; the distribution of token counts rather than the average, since context overflows happen in the tail; tool error rate per tool; classifier confidence and the rate of "not sure" results; override rate per route; and counts of budget denials and fallbacks.

The spend report holds most of these, read from `usage` so its figures match what budgets were charged: cost by day, person, model, workspace, surface and route, the median and 95th percentile of latency and token counts, downgraded and refused requests, and tool calls by tool with their failures (ADR 0055, ADR 0079). Threshold alerts go to a webhook an admin configures (BG-10, ADR 0054). Overrides per route are on the routing page (ADR 0048), and every usage row and trace carries the routing rule and confidence.

The last three are product metrics, not operational ones. They tell us whether routing is working, which no generic observability tool would think to ask.

### Deployment

**Base image: Debian slim, never Alpine.** There are no musl builds of the ONNX runtime, so Alpine means compiling it from source in the Dockerfile. That's a wasted afternoon, and it comes back with every dependency update. Caddy's official image is Alpine-based, so we build Caddy from the same release onto Debian slim (ADR 0011, ADR 0086). Both images apply Debian's security fixes when they're built, whatever the base image's age (ADR 0099).

**One image for every process.** api, worker, web, the sandbox's tool host, the egress proxy and the init job run from one image with a subcommand, so there's one multi-arch build and one version per release, and the classifier weights are stored once (ADR 0014). Our two images together are about 276 MB, against a 1 GB budget (NF-D6, ADR 0088).

**Multi-arch** for `linux/amd64` and `linux/arm64`, published as a manifest list. Each architecture is built on its own native runner, pushed by digest, pulled back and checked, then joined into the manifest list and signed (ADR 0086). An amd64-only image would run under emulation on Apple Silicon, and emulation is slowest on SIMD-heavy number crunching. The classifier would take seconds instead of milliseconds, and someone trying the product on their laptop would decide it's slow.

**Model weights baked into the image.** This meets the offline-start requirement (NF-D5) and avoids needing the network on first boot. The weights are fetched at build time, pinned by size and SHA-256, and the ONNX runtime's CPU binaries come in its npm package, with its install-time download turned off (ADR 0022). That makes the *build* depend on the network, which only matters for fully reproducible or air-gapped builds. CI proves the offline start by running a release bundle on a network with no route out.

**Migrations run automatically on start**, forward-only, and the service refuses to start on a schema mismatch instead of carrying on (AD-4, NF-O1). Our own runner applies them under an advisory lock, so the api and worker can start together, and refuses a database that's ahead of the code, an edited migration, or a migration merged out of order (ADR 0026).

**Secrets come from the environment or the secrets volume.** If they're missing, the `init` service generates them on first run and never prints them. The credential master key is shown once, on the first-run setup screen in the browser, with a clear warning to save it (ADR 0004, ADR 0021); after a rotation the new one is read with `lakka recovery-key` (ADR 0115). Losing it means losing every stored provider credential, which is why the backup includes the secrets (ADR 0084). The sandbox's two keys, the tool host's token and the egress signing key, live in volumes of their own that only the services using them mount; they are not backed up, since init makes new ones when they are missing (ADR 0118).

**Health and shutdown.** `/healthz` reports Postgres and Valkey as required, and the classifier and each instance provider credential as optional: a failed optional check answers 200 with `degraded`, so a provider outage never makes compose restart the api, and a failed required check answers 503 (AD-5, ADR 0017, ADR 0081). The sandbox is not part of it, since the api does not depend on it; the diagnostics bundle says whether the api reaches the tool host and the egress proxy (ADR 0118). On SIGTERM the api refuses new requests, gives requests in flight 20 seconds to finish, then ends the rest with a `server_shutting_down` error and settles their partial usage (NF-O5, ADR 0081).

**Releases** are a bundle of the compose files with every image pinned by digest, Postgres and Valkey included, so no tag can change under a release. Images are scanned with Trivy, and a HIGH or CRITICAL finding with a fix fails the build (NF-S7, ADR 0086).

### Testing strategy

| Layer | Approach |
| --- | --- |
| Unit (Vitest) | `core` on its own, with no HTTP and no database. Resolution order, threshold logic, estimate arithmetic. Includes the import boundary test |
| Integration | Real Postgres (16 and 18) and Valkey in containers, with a scriptable fake provider and real MCP, OIDC and OAuth servers. Budget concurrency, migrations, isolation |
| Contract | The OpenAI-compatible surface tested against the official TypeScript and Python SDKs and against unmodified Open WebUI and LibreChat, as a gate rather than a hope (ADR 0064) |
| Failure injection | The budget scenarios from the budget section, **written before the implementation**; also the rate limit with Valkey down, a key rotation killed part way, and the sandbox or its proxy stopped (ADR 0113, ADR 0115, ADR 0118) |
| Acceptance (Playwright) | Against the full compose stack with the fake provider, on both architectures, in CI, with accessibility checks on each page. The M7 gate maps all 21 criteria to the tests that prove them |
| Out of process | A tool run through the locked-down runner container (TL-8, ADR 0073) |
| Sandbox | A probe stdio server in the running stack's sandbox: what it can read, write, resolve and reach, its limits, and the sandbox and the proxy stopped or killed under it (NF-S4, ADR 0118) |
| Release | A release bundle's first run, cold start and offline start; an upgrade in place from the previous release, filled with data; a vulnerability scan (ADR 0086) |
| Classifier evaluation | A held-out labelled set in five languages, run inside the image on every change. CI fails below 80% accuracy in English and 75% in the others (ADR 0045, ADR 0088) |

CI runs these in six jobs: `check`, `integration` on Postgres 16 and on 18, `image` and `stack` on each architecture, `out-of-process` and `upgrade`. `stack` runs the acceptance, compatibility, sandbox, diagnostics and backup checks against one running stack. `pnpm ci:local` runs the same jobs from a clean clone on one machine, on its own architecture (ADR 0065).

Two habits to commit to:

**Test isolation by calling the API directly, not by clicking through the UI.** Acceptance criterion 16 is about what a determined member can reach by crafting their own requests, and no amount of UI testing will show that.

**Classifier evaluation reports the variation, not just the average.** Results change between runs, and a two-point improvement inside a five-point spread isn't an improvement. It's also why "it worked when I tried it" doesn't count as evidence for a routing change.
