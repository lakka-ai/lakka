# Requirements

## Scope

### What v1 is

A single self-hosted service that governs how a small team uses AI: identity, model policy, spending, tool access and audit. The same rules apply across the web chat, an OpenAI-compatible API, and MCP.

The test for any proposed feature fits in one sentence: *does this help a team of 10 to 50 people with no platform engineer control what their AI costs, what it does, and what it can touch?* If not, it's not in v1.

### The v1 scope

Seven capability areas, in order of dependency:

1. **Spine**: principals, workspaces, memberships, authentication
2. **Provider configuration**: bring your own keys, encrypted at rest, with a maintained pricing table
3. **Routing policy**: admin-defined routes, a built-in classifier, override tracking
4. **Budgets**: cost estimate before sending, fail-closed enforcement, fallback to cheaper models
5. **Surfaces**: web chat and an OpenAI-compatible API sharing one identity and one policy path
6. **Tools**: MCP client with per-user credentials and approval steps
7. **Observability**: tracing with cost and routing decision on every record

### Deferred to v2 and later

Not rejected, but clearly outside v1 and not something to design for now: knowledge bases and retrieval, scheduled and durable agent runs, the evaluation loop and policy replay, the outbound MCP server surface, sandboxed code execution, SSO/SAML beyond OIDC, and multi-instance or high-availability deployment.

There's one exception: **the sandbox boundary has to exist in the v1 architecture.** Security boundaries can't be added convincingly later, so tool execution goes through a separate dispatch layer from day one. Stdio MCP servers run through it in a sandbox whose only network is an allowlisting proxy (ADR 0118); tools that run code stay in v2.

### Non-goals, carried over

These come from the strategy document. They're repeated here because requirements documents are where non-goals tend to slip:

- **No visual workflow builder.** Customers who need one can point n8n or Dify at our API.
- **No model serving.** We integrate with Ollama and vLLM; we don't run inference.
- **No agent orchestration building blocks.** We're not competing with LangGraph or MAF on graphs, supersteps or durable workflow semantics.
- **No model reselling.** Customers always bring their own keys. This is about trust.
- **No telemetry sent to us.** No phone-home, including for pricing updates, which have to be optional and work offline.

### Definition of done for v1

v1 ships when all of these are true on a clean machine we've never seen:

- `docker compose up` reaches a usable state with no manual configuration
- An admin can add a provider key, set up a route policy, set a workspace budget and invite a colleague, all through the web UI and without editing any files
- A person chatting and a script calling the OpenAI-compatible endpoint are held to the same budget and the same model policy, and both produce records in the same usage ledger
- A budget cap can't be exceeded, including under concurrent load and when a request is streaming
- Every model call produces a trace record with the model, tokens, cost, latency, and the routing decision that picked it

## Functional requirements

Each requirement has a domain prefix. **MUST** blocks the v1 release. **SHOULD** is planned for v1 but can be dropped if time runs short.

How to read status: the Status column, here and in the non-functional tables, says what v1 does. It is taken from the code, the tests named by requirement ID, the ADRs and the milestone gates (`docs/gates/`). The requirement text stays as written; where an ADR settles how v1 reads it, the Status cell names that ADR.

- `built`: in v1.
- `partial`: part built; the cell says what is missing.
- `deferred`: deliberately left out of v1 by the ADR named.
- `not built`: a SHOULD that v1 does not do, and no ADR defers.

### ID: Identity and workspaces

|  | Requirement | Status |
| --- | --- | --- |
| ID-1 | **MUST** map every request to a single *principal* (a person or an issued key), whatever surface it came from | built (ADR 0066) |
| ID-2 | **MUST** support local accounts with email and password, and OIDC as an alternative | built |
| ID-3 | **MUST** support workspaces with three roles: instance admin, workspace admin, member | built |
| ID-4 | **MUST** allow a principal to belong to several workspaces with a different role in each | built |
| ID-5 | **MUST** let a member issue API keys scoped to one workspace, which inherit that member's permissions and budget | built |
| ID-6 | **MUST** let an admin revoke a key or suspend a principal, with effect within seconds | built |
| ID-7 | **SHOULD** support inviting a colleague by link even when no outgoing mail server is configured (a link that can be copied) | built |
| ID-8 | **SHOULD** let an instance admin delete a workspace, removing its content and credentials while keeping its spend in the instance's records (ADR 0104) | built |

ID-5 is the one everything else depends on. A key is not a separate identity with its own permissions. It's a delegation of a person's permissions. That's what makes budgets and audit mean something across surfaces.

### PR: Providers and keys

|  | Requirement | Status |
| --- | --- | --- |
| PR-1 | **MUST** let provider credentials be added, tested and removed in the web UI, without editing files | built |
| PR-2 | **MUST** encrypt provider credentials at rest, with the encryption key coming from the environment and never stored in the database | built (ADR 0004) |
| PR-3 | **MUST** never show a stored credential back to any user, admins included | built |
| PR-4 | **MUST** support at least Anthropic, OpenAI, Google and any OpenAI-compatible endpoint (which covers Ollama, vLLM and OpenRouter) | built; DeepSeek, Moonshot AI, Qwen Cloud, Xiaomi MiMo and Z.ai too (ADR 0126) |
| PR-5 | **MUST** ship a model catalogue with per-token pricing that works fully offline | built |
| PR-6 | **SHOULD** allow the catalogue to be refreshed from a signed feed, opt-in and off by default | built (ADR 0116) |
| PR-7 | **MUST** let an admin add a model the catalogue doesn't know, entering its pricing by hand | built (ADR 0037) |
| PR-8 | **MUST** scope provider credentials to a workspace or to the whole instance, with workspace credentials taking priority | built |

### RT: Routing policy

|  | Requirement | Status |
| --- | --- | --- |
| RT-1 | **MUST** let a workspace admin define named routes, each linking a task label to a model and an ordered list of fallbacks | built |
| RT-2 | **MUST** let each route have example phrasings, entered as plain text in the UI | built |
| RT-3 | **MUST** choose the model for a request in a fixed order: explicit user choice -> workspace pin -> deterministic signal -> classifier above threshold -> workspace default | built (ADR 0046) |
| RT-4 | **MUST** classify without any network call, using a model shipped inside the image | built |
| RT-5 | **MUST** use separate confidence thresholds for routing to a more expensive model and to a cheaper one, with the cheaper direction needing higher confidence | built (ADR 0046) |
| RT-6 | **MUST** fall back to the workspace default when no route clears its threshold | built |
| RT-7 | **MUST** classify once per conversation and keep that decision, re-evaluating only on an explicit signal and not on every message | built (ADR 0046) |
| RT-8 | **MUST** record, for every request, which rule chose the model and with what confidence | built |
| RT-9 | **MUST** record when a user changes the model after a routing decision, and link that override to the route that lost | built |
| RT-10 | **SHOULD** show accumulated overrides to the admin as a suggested policy change with an estimated cost effect | built (ADR 0048, ADR 0114) |
| RT-11 | **MUST** let an admin turn routing off completely for a workspace | built |
| RT-12 | **SHOULD** let the classifier use a route's description, alone before the route has examples and alongside them after, with accuracy limits documented | built (ADR 0122, ADR 0125) |

RT-11 matters more than it looks. A customer who doesn't trust the classifier has to be able to switch it off and still have a working, useful product. Routing is how we get in the door, not something the product depends on.

### BG: Budgets and cost

|  | Requirement | Status |
| --- | --- | --- |
| BG-1 | **MUST** support budget limits at instance, workspace, member and key level, with nesting (a member cap sits inside a workspace cap) | built |
| BG-2 | **MUST** estimate the cost of a request before sending it, using prompt tokens plus the maximum possible output at the chosen model's price | built |
| BG-3 | **MUST** reserve the estimated cost atomically before sending, so that concurrent requests can't together go over a cap | built |
| BG-4 | **MUST** fail closed: if the authoritative store can't be reached, requests are refused, never served | built |
| BG-5 | **MUST** compare actual cost with the reserved amount when a request completes, and release the difference | built |
| BG-6 | **MUST** release reservations left behind by crashed or abandoned requests without an operator stepping in | built |
| BG-7 | **MUST**, when a cap is reached, try falling back to a cheaper route before refusing, and tell the user what happened in plain language | built (ADR 0053) |
| BG-8 | **MUST** attribute every unit of spend to a principal, a workspace, a model and a routing decision | built |
| BG-9 | **MUST** support configurable reset periods (daily, monthly, none) | built |
| BG-10 | **SHOULD** send an alert to a configurable webhook at set thresholds | built |
| BG-11 | **MUST** offer a spend view a non-technical buyer can understand: by person, by workspace, by model, over time | built |
| BG-12 | **SHOULD** limit how many model requests one person, their keys included, can start per minute on every surface, and refuse the rest saying how long to wait | built (ADR 0113) |

BG-4 deliberately does the opposite of what at least one well-known gateway does, and it's a marketing claim as much as an engineering one. It has to hold under load, while streaming, and when the database fails.

### CH: Chat surface

|  | Requirement | Status |
| --- | --- | --- |
| CH-1 | **MUST** provide streaming conversations with model selection, conversation history and renaming | built (ADR 0057) |
| CH-2 | **MUST** show the user which model answered and why, when routing chose it | built |
| CH-3 | **MUST** let a user override the model for a conversation, and record the override | built |
| CH-4 | **MUST** show the remaining budget when a cap is set, and explain any fallback at the moment it happens | built |
| CH-5 | **MUST** support file and image attachments where the chosen model supports them | built |
| CH-6 | **SHOULD** support sharing conversations within a workspace | deferred (ADR 0057) |
| CH-7 | **MUST** turn any provider error into a clear message the user can act on, never a raw status code | built |

### API: OpenAI-compatible surface

|  | Requirement | Status |
| --- | --- | --- |
| API-1 | **MUST** implement `/v1/chat/completions` with streaming and non-streaming responses | built |
| API-2 | **MUST** implement `/v1/models`, returning only the models the authenticated principal is allowed to use | built |
| API-3 | **MUST** apply exactly the same policy, budget and audit logic as the chat surface, through a shared code path rather than a parallel implementation | built |
| API-4 | **MUST** accept an optional route name, so a script can explicitly ask for policy-based selection | built |
| API-5 | **MUST** return budget refusals as a documented, machine-readable error that can be told apart from provider errors | built |
| API-6 | **SHOULD** be compatible enough that an existing Open WebUI or LibreChat deployment can point at it without changes | built |

API-6 is the "add to what they have" approach from the strategy document, written as a requirement. It should be tested against those two products specifically, as an acceptance criterion and not just a hope.

### TL: Tools and MCP

|  | Requirement | Status |
| --- | --- | --- |
| TL-1 | **MUST** connect to MCP servers over stdio and Streamable HTTP, configured in the web UI | built |
| TL-2 | **MUST** support per-user credentials for MCP servers through OAuth where the server offers it, so the server sees the end user and not a shared service account | built |
| TL-3 | **MUST** let an admin choose which tools are available in which workspace | built |
| TL-4 | **MUST** support marking a tool as needing approval, and show approval requests to the user before it runs | built |
| TL-5 | **MUST** support standing approvals per principal per tool, which both the user and the admin can revoke | built |
| TL-6 | **MUST** record every tool call with the principal, arguments, result status and the identity whose credentials were used | built (ADR 0066) |
| TL-7 | **MUST** treat tool results as untrusted data when building prompts, with clear delimiters | built |
| TL-8 | **MUST** run tool execution through a dispatch layer that can run tools out of process, even though v1 runs them in process | built (ADR 0073, ADR 0118) |
| TL-9 | **MUST** enforce a per-request limit on how many times tools can be called in a loop | built |

### OB: Observability

|  | Requirement | Status |
| --- | --- | --- |
| OB-1 | **MUST** produce a trace per request, with spans for model calls, tool calls and routing decisions | built |
| OB-2 | **MUST** follow the OpenTelemetry GenAI semantic conventions for span and attribute names | built |
| OB-3 | **MUST** store traces locally by default, with no external dependency | built |
| OB-4 | **MUST** leave prompt and response content capture **off** by default, with per-workspace opt-in and a visible retention setting | built |
| OB-5 | **MUST** support OTLP export so a customer can send traces to their own backend | built |
| OB-6 | **MUST** enforce a retention policy on traces and usage records, with a documented default | built |
| OB-7 | **SHOULD** let a user flag a response as unsatisfactory, saving the trace for later review | deferred (ADR 0075) |

OB-4 makes debugging harder, and that trade-off is intentional. The default protects a customer who hasn't thought about it; the opt-in is there for one who has.

### AD: Administration

|  | Requirement | Status |
| --- | --- | --- |
| AD-1 | **MUST** complete first-run setup in the browser, with no configuration files to edit to reach a working state | built |
| AD-2 | **MUST** provide a single-command backup and restore that covers the database and secrets | built (ADR 0084, ADR 0115) |
| AD-3 | **MUST** provide a diagnostics bundle a user can generate and attach to a support request, with credentials removed | built |
| AD-4 | **MUST** run database migrations automatically on startup, and refuse to start rather than run against an incompatible schema | built |
| AD-5 | **MUST** expose a health endpoint that reports database, cache, classifier and provider reachability separately | built |
| AD-6 | **SHOULD** show the AGPL source-availability notice with a link to the corresponding source, meeting Section 13 of the AGPL for network users | built |

AD-6 is a licence obligation, not a nice extra, and it applies to our own hosted offering just as much as to a customer's.

## Non-functional requirements

### Deployment simplicity

This is the product's promise, so it's a requirement, not a goal.

|  | Requirement | Status |
| --- | --- | --- |
| NF-D1 | `docker compose up` on a clean machine reaches a working first-run screen with no prior configuration | built |
| NF-D2 | Time from that command to the first successful model call: **under 10 minutes**, including the operator reading the setup screens | built |
| NF-D3 | The compose file needs no editing for a default deployment; every setting has a working default | built |
| NF-D4 | Images published for `linux/amd64` and `linux/arm64`, both tested in CI | built: published for both from v1.0.0-beta.1, and CI tests both (docs/gates/m8.md) |
| NF-D5 | Model weights bundled in the image, not downloaded at boot, so the product can start with no internet access | built |
| NF-D6 | Total pulled image size under 1 GB | built (ADR 0023) |
| NF-D7 | Cold start to serving requests in under 30 seconds on modest hardware | built |
| NF-D8 | Runs acceptably on 2 vCPU / 4 GB RAM for a 10-person team | partial: not yet measured on reference hardware (docs/gates/m7.md) |

NF-D5 and NF-D8 directly limit the classifier choice: quantised ONNX rather than PyTorch, and a Debian-based image rather than Alpine.

### Performance

These are limits, not wishes. Measured at p95 on the reference hardware above.

|  | Target |
| --- | --- |
| Classification latency | < 100 ms, and < 5% of time to first token, with the default model; < 200 ms with the larger model an operator can choose (ADR 0123) |
| Policy pipeline overhead | < 150 ms added to any request, not counting the model call |
| Budget reservation | < 20 ms |
| Time to first streamed token | Provider latency plus platform overhead, with overhead under 200 ms |
| Admin UI interaction | < 500 ms for any read view |
| Concurrent conversations | 50 on reference hardware without slowing down |

In v1 only classification latency is measured, by `lakka embed-bench` in the CI image job (docs/gates/m3.md). The other targets have no test yet.

The policy pipeline sits in front of every request on every surface. If it's slow, the product is slow, and no amount of governance makes up for that.

### Security

|  | Requirement | Status |
| --- | --- | --- |
| NF-S1 | Provider credentials encrypted at rest with a key from the environment, never stored alongside the ciphertext | built |
| NF-S2 | Authorisation checked against the end user's identity, never the platform's; an API key can't reach anything its owner can't | built |
| NF-S3 | Tool execution kept behind a dispatch boundary that can separate it into another process | built (ADR 0073, ADR 0118) |
| NF-S4 | Outbound network access from tool execution blocked by default and allowed only by explicit allowlist | built (ADR 0117, ADR 0118) |
| NF-S5 | No credentials, prompt content or tool arguments written to application logs at any level | built |
| NF-S6 | All session and key material sent only over TLS in any documented deployment | built (ADR 0008) |
| NF-S7 | Dependency and container scanning in CI, with a published process for reporting vulnerabilities | built |
| NF-S8 | Tool results and retrieved content marked as data when building prompts, never mixed into the instructions | built |
| NF-S9 | The credential master key can be rotated without losing stored credentials or the ability to restore older backups | built (ADR 0115) |

NF-S2 is the requirement most likely to be broken for convenience during implementation, and breaking it has the worst consequences. It belongs in code review criteria, not only here.

### Privacy and data handling

|  | Requirement | Status |
| --- | --- | --- |
| NF-P1 | No telemetry leaves the instance by default: no usage reporting, no error reporting, no analytics | built |
| NF-P2 | Any optional outbound connection (pricing feed, update check) is off by default and can be switched on individually | built (ADR 0116) |
| NF-P3 | Prompt and response content capture is off by default; turning it on is an explicit admin action that gets logged | built |
| NF-P4 | An admin can export and delete all data linked to a principal | built (ADR 0082) |
| NF-P5 | Retention periods can be set for traces, usage records and conversations, and a scheduled job enforces them | built |

NF-P1 is a commitment about who we are as much as a technical rule. Breaking it even once would cost more trust than any analytics could be worth.

### Compatibility

|  | Requirement | Status |
| --- | --- | --- |
| NF-C1 | OpenAI-compatible endpoint verified against Open WebUI, LibreChat and the official OpenAI SDKs for Python and TypeScript | built |
| NF-C2 | Postgres 16 or later and Valkey, or another server speaking the Redis 7.2 protocol or later; no dependency on managed cloud versions | built (ADR 0009) |
| NF-C3 | Modern evergreen browsers; no support for IE or old Safari versions | built |
| NF-C4 | Can be deployed behind a customer's existing reverse proxy at a subpath | deferred (ADR 0075) |
| NF-C5 | MCP protocol compliance verified against reference server implementations | built |

### Operability

|  | Requirement | Status |
| --- | --- | --- |
| NF-O1 | Migrations are forward-only and automatic; startup stops on a schema mismatch instead of carrying on | built |
| NF-O2 | Backup produces a single restorable file that includes secrets | built |
| NF-O3 | Structured logs with a configurable level, safe to share once redacted | built |
| NF-O4 | The health endpoint reports failures per component, so an operator can tell a provider outage from a database problem | built |
| NF-O5 | Graceful shutdown finishes in-flight streams and releases budget reservations | built |
| NF-O6 | The upgrade path is documented and tested from at least one earlier minor version | built (ADR 0075) |

### Accessibility and internationalisation

|  | Requirement | Status |
| --- | --- | --- |
| NF-A1 | WCAG 2.1 AA for the chat and admin surfaces: keyboard navigation, focus handling, contrast, and screen-reader labels on interactive controls | built |
| NF-A2 | UI strings kept outside the code from day one, even if only English ships in v1 | built |
| NF-A3 | Classifier route examples accept non-English text without errors, with accuracy limits documented | built (ADR 0088) |

A note on NF-A3: the small English-first embedding models are the fast, small option, and multilingual versions are bigger. With European customers in our target market, v1 ships a multilingual model, and the guide states its accuracy per language (ADR 0088). The classifier stays swappable through configuration (`LAKKA_CLASSIFIER_MODEL_DIR`), and the image carries a second, larger multilingual model for operators who need non-English accuracy at or above 80% (ADR 0123).

## Constraints and assumptions

### Hard constraints

- **Single-node deployment.** v1 assumes one instance. Horizontal scaling is a concern for v2 or later and shouldn't make the v1 design more complex, but nothing in the design should rule it out. In particular, no in-process state that couldn't move to Postgres or Valkey.
- **Only two stateful dependencies.** Postgres and Valkey (ADR 0009). Adding a third (a vector database, a trace store, a message broker) needs a clear justification against the requirement to keep the compose file simple.
- **AGPL v3 for all code.** Every dependency has to be licence-compatible. That rules out some options that are permissively licensed but patent-encumbered, and it needs checking for each dependency rather than assuming.
- **No paid third-party services in the runtime path.** A self-hosted instance has to work without an account anywhere except the customer's own model providers.
- **A classifier swappable through configuration.** v1 bundles a multilingual model (ADR 0088), and `LAKKA_CLASSIFIER_MODEL_DIR` replaces it with another.

### Assumptions

Written down so they can be checked rather than quietly accepted:

- Teams will accept a routing policy set by an admin instead of each user choosing a model, as long as they can always override it.
- A nearest-centroid classifier built from a dozen admin-written examples is accurate enough to help overall when it's allowed to say "not sure." **This is the assumption most likely to be wrong**, and discovery Question 2 exists to test it before this document's design is locked in.
- Postgres is good enough for trace storage at small-team volume, with partitioning and retention. A customer with enough traffic to prove otherwise is outside our target market.
- More and more MCP servers in customers' environments support OAuth, which makes per-user credentials practical rather than theoretical. Where they don't, we fall back to a shared credential and show that in the audit trail.
- Operators can run `docker compose` and set up TLS. Anything beyond that is outside our target market.

### Outcome of discovery

All three discovery questions were resolved in favour of going ahead. Classifier-driven routing is in scope with no conditions, and the priorities in this document stand as written.

| Question | Outcome |
| --- | --- |
| 1: Is the pain real, and does it rank high? | Yes |
| 2: Does routing save money, and is the classifier accurate enough? | Yes |
| 5: Is an incumbent moving? | No movement seen; the gap is still open |

RT-1 through RT-10 are in scope unconditionally, BG-11 keeps its priority, and API-6 stands. The M0 gate is cleared and M3 goes ahead unconditionally.

Two practical notes, neither of them a gate:

- The routing thresholds and the accuracy figure in acceptance criterion 11 were calibrated on the evaluation set in M3 (ADR 0045) and again for the multilingual classifier (ADR 0088). Centroid matching with `threshold_down` 0.35 and `threshold_up` 0.25 scores 84% in English against the 80% bar. The tech spec's starting thresholds routed almost nothing and were replaced.
- The evaluation set is kept as a versioned artifact, `packages/core/eval/routing-v1.json`, with German, French, Spanish and Swedish translations, and CI runs it in the image job (ADR 0045, ADR 0088). It's the regression suite for every later change to the routing logic or the default embedding model. It is self-written and provisional until real traffic replaces or extends it.

Some questions still can't be answered before the product exists: whether users trust routing or override it until it's pointless, whether most traffic lands in the "not sure" bucket, and whether admins actually use the improvement loop. Design-partner deployments will answer those. If the answers are bad, RT-11 (turning routing off per workspace) is the fallback, which keeps it a configuration change rather than a rewrite.

Re-check the competition at each milestone boundary. No movement today is a snapshot, not a guarantee.

## Acceptance criteria for v1

Each one is testable, and each one is a gate rather than a goal.

### Deployment

1. On a clean Ubuntu host and a clean Apple Silicon Mac, `docker compose up` reaches the first-run screen with no errors and no edits.
2. With no outbound internet access except to the model provider, the instance starts and serves a request.
3. The total pulled image is under 1 GB and cold start takes under 30 seconds.

### One policy across every surface

This is the core of the product, so it gets the most explicit test.

4. Given a member with a $10 monthly cap who has spent $9.50: a chat request and an API request using that member's key both see the same remaining balance, and whichever arrives second is downgraded or refused, no matter which surface it came from.
5. Given a workspace route policy that sends code requests to model X: a chat message and an API call with equivalent content both pick X, and both record the same routing rule in their usage records.
6. Revoking a member's access ends their chat sessions and invalidates their keys within 5 seconds.

### Budget integrity

7. 50 concurrent requests against a budget that covers 10 result in at most 10 being sent, with no cap breach.
8. Killing the API process mid-stream leaves no reservation held forever; the reservation is released within the configured orphan window.
9. With Postgres unreachable, requests are refused with a clear error. No request is served.
10. A request whose maximum possible output would go over the remaining budget is downgraded or refused before it's sent, not after.

### Routing

11. Against a labelled evaluation set, routing picks the intended model for at least 80% of clearly typed requests, with "not sure" counted as correct where confidence really is low.
12. A user switching models after a routing decision creates an override record linked to the losing route.
13. Turning routing off for a workspace leaves every other function working.

### Compatibility

14. An unmodified Open WebUI instance configured against our endpoint can list models and hold a streaming conversation, subject to our budgets and policy.
15. The official OpenAI SDKs for Python and TypeScript work against the endpoint without special handling.

### Security

16. A workspace member can't read another workspace's conversations, keys, traces or usage, checked by calling the API directly rather than by clicking through the UI.
17. Provider credentials don't appear in API responses, logs or the diagnostics bundle.
18. A tool marked as needing approval can't run without a recorded approval from the principal who called it.

### Observability

19. Every model call produces a trace span with the model, token counts, cost, latency and routing decision.
20. With content capture off, no prompt or response text appears anywhere in the trace store.
21. Retention enforcement demonstrably deletes records older than the configured window.

### Where each criterion was proved

Each milestone gate in `docs/gates/` records the tests that proved its criteria. The M7 gate lists all 21 as covered by automated tests, and records clean-machine runs on an Ubuntu 24.04 host (amd64) and an Apple Silicon Mac that followed only `docs/guide/`. Where GitHub Actions was unavailable, the CI workflow ran through `pnpm ci:local` (ADR 0065); the gates say what that leaves to confirm.

| AC | Gate | Notes |
| --- | --- | --- |
| 1 | M1, M7 | M1 in CI on amd64 and arm64 and on an Apple Silicon Mac; M7 on the two clean machines |
| 2 | M7 | A release bundle started on a compose network with no route out |
| 3 | M7, M8 | Size counts our two images only (ADR 0023): 272 MB at M7, 276 MB at M8. Cold start 12.5 to 13.1 s in CI and 18.1 and 20.5 s on the clean machines at M7; 15.2 and 15.4 s in CI at M8, with the sandbox and egress services. M1 checked the size alone |
| 4 | M5 | Both orders: chat first and API first |
| 5 | M5 | |
| 6 | M1, M5 | M1: keys and sessions refused within 5 s. M5: running chat and API streams ended within 5 s (ADR 0063) |
| 7 | M4 | At the reservation engine and through the entry point |
| 8 | M4 | The test uses a 3-second hold; in production the window is 15 minutes plus 30 seconds (ADR 0052) |
| 9 | M4 | |
| 10 | M4 | Both outcomes: downgraded to a model that fits, and refused (ADR 0053) |
| 11 | M3, M7 | 82.5% in M3 with thresholds tuned on a self-written evaluation set (ADR 0045); 84.3% with the multilingual model in M7 (ADR 0088). CI fails below 80%. The gates call the set provisional, and the margin small |
| 12 | M3 | |
| 13 | M3 | Also with no classifier at all (invariant 10) |
| 14 | M5 | LibreChat too, for API-6 (ADR 0064) |
| 15 | M5 | |
| 16 | M1, then each later milestone | M1 covered workspaces, members, keys and invites. By M7, conversations, traces, budgets and usage, providers, routes, MCP servers and tools are covered too, and M8 added route example candidates |
| 17 | M7, M8 | Including the diagnostics bundle (ADR 0083); at M8 also the sandbox's two keys (ADR 0118) |
| 18 | M6 | |
| 19 | M7 | ADR 0076 |
| 20 | M7 | ADR 0077 |
| 21 | M7, M8 | ADR 0078. M8: a route example candidate goes when its recorded content expires (ADR 0114) |
