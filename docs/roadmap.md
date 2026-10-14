# Roadmap

*The order of phases follows dependencies and risk, not how appealing each feature is.*

**Status:** the v1 milestones, M1 to M7, are done, and so is M8, which closed what v1 left open. So is M9, the project site, deployed at https://lakka-ai.github.io/lakka/. So is M10, routing accuracy. Each gate is recorded in `docs/gates/`, and their checks pass on amd64 and arm64 in GitHub Actions. The first release, v1.0.0-beta.1, is published, which opens v1.x; the latest is v1.0.0-beta.3.

## Sequencing principles

Five rules set the order. Now and then they conflict, and when they do, the lower number wins.

**1. Deal with the biggest risk first, even when it isn't the biggest feature.** Discovery settled the classifier question before any product code depended on it, which is why the plan now starts at M1. The same logic applies during the build: the multi-arch deployment path and the streaming transport are proven as spikes in M1, because either could invalidate later work, and both are far cheaper to find out about early than at release.

**2. Build the shared layer before the surfaces.** The unified policy pipeline is the core of the product. If chat and the API are built separately with a plan to unify them later, that never happens. The unification turns into a refactor nobody gets around to. So the pipeline and the API come first, and chat is built as a client of our own endpoint.

**3. Work where correctness is critical gets its own milestone.** Budget enforcement is a concurrency problem with a marketing promise attached. If it's squeezed in alongside feature work, it'll end up roughly right, which here means wrong.

**4. Security boundaries go in at the start or not at all.** The tool dispatch layer and the per-user credential model are architectural. Adding them later means rewriting the tool layer and re-auditing everything that touched it.

**5. Anything that can wait, waits.** Knowledge bases, agents, evaluation and the outbound MCP surface are all valuable, and none of them are in v1. The usual way a small team fails is by building a broad, shallow product that loses to focused free alternatives.

### Dependency graph

```
M1 Spine -> M2 Gateway -> M3 Policy -> M4 Budgets -> M5 Surfaces -> M6 Tools -> M7 Observability

M1: identity gates everything after it
M3: routing feeds the budget fallback in M4
M7: cross-cutting; spans are emitted from M2 onward, storage and UI land last
```

Observability comes last in the list but is built in throughout. Spans are emitted from M2 onward, and M7 covers storage, retention and the UI rather than the instrumentation itself. Adding tracing later across a gateway, a policy pipeline and a tool runtime is much harder than passing a trace context through from the start.

### What each milestone may leave for later

A standing rule to stop scope leaking backwards: each milestone meets its own quality bar (tests, migrations, docs), but it can leave polish on surfaces it doesn't own. M4 can leave the budget admin UI ugly. M5 can't leave budget enforcement half done.

### Estimation stance

**No durations are given, on purpose.** These milestones are ordered, not scheduled. The order reflects dependencies and risk, and that ordering is what's useful here. A duration next to it would be made up, would be read as a promise, and would start being tracked against.

What the plan does say about proportion, it says through structure rather than numbers. Budget correctness gets its own milestone because it deserves as much weight as a whole surface, and M1 through M5 are marked as a shippable subset, so that running short on capacity has a planned answer rather than a panicked one.

## Milestones

### M1: The spine and foundational spikes

**Status:** done. Gate: [docs/gates/m1.md](gates/m1.md).

*The plan starts here. Discovery is complete, and its outcomes are recorded in [docs/requirements.md](requirements.md).*

**Goal:** principals, workspaces and authentication, done well enough that nothing later needs to revisit them, plus the two engineering spikes that would be expensive to discover late.

**Scope:** data model and migrations; local auth and OIDC; workspaces, memberships and roles; API keys issued as delegations of a member's identity; the admin shell; the first-run setup flow; a compose skeleton with Postgres and Valkey.

**Spikes brought into this milestone:**

| Spike | Why it can't wait |
| --- | --- |
| Multi-arch image with the ONNX runtime, booting on x86 and ARM | The release pipeline depends on it, and finding problems at M7 would hold up the release |
| Fastify SSE through the reverse proxy, with first-chunk buffering | The commitment window shapes the whole gateway design in M2 |

**Exit criteria:** an admin can finish first-run setup in a browser, invite a member, issue a key, and revoke both. Isolation between workspaces is checked by calling the API directly, not by clicking through the UI. Both spikes work on both architectures.

**Why first:** every later milestone attaches something to a principal. Getting ID-5 wrong (treating keys as independent identities rather than delegations) breaks budgets, policy and audit all at once.

**Later polish:** deleting a workspace (ID-8, ADR 0104), added and built after M1's gate passed. It does not reopen the gate: it brings its own tests, and the isolation and budget guarantees above must still hold after a delete.

### M2: Provider gateway

**Status:** done. Gate: [docs/gates/m2.md](gates/m2.md).

**Goal:** one internal interface to every provider, with accurate cost accounting.

**Scope:** a provider layer over the AI SDK; encrypted credential storage; a bundled, offline-capable model catalogue with pricing; streaming normalisation with first-chunk buffering; error classification (retryable or terminal); failover chains; token and cost accounting, including cached tokens; OTel spans from here on.

**Exit criteria:** a request routed to any configured provider returns a correct cost record. Killing a provider mid-request triggers the documented failover behaviour. Cost figures match the provider's own reported usage within a small margin.

**Watch out for:** streaming commitment. Once a token has been sent to the client, failover is no longer possible. The buffering window has to be proven here, not discovered in M5.

### M3: Policy and routing

**Status:** done. Gate: [docs/gates/m3.md](gates/m3.md).

*Ungated. The classifier question was settled in discovery.*

**Goal:** the main differentiator, working end to end.

**Scope:** route definitions with example phrasings; the ONNX embedding runtime in process, loaded lazily; centroid computation when a policy is saved; the tiered resolution order; separate thresholds per direction and the "not sure" fallback; one routing decision per conversation; deterministic signal detection; override tracking; the routing admin UI; turning routing off per workspace.

**Exit criteria:** acceptance criteria 11 to 13. Classification latency under 100 ms at p95 on reference hardware. Every request carries a recorded routing decision with its confidence and the rule that produced it.

### M4: Budgets

**Status:** done. Gate: [docs/gates/m4.md](gates/m4.md).

*Correctness milestone.*

**Goal:** a cap that can't be exceeded.

**Scope:** nested budget scopes; cost estimation before sending, including maximum output; atomic reservation in Valkey with Postgres as the source of truth; reconciliation on completion; releasing orphaned reservations; fail-closed behaviour when a store is unavailable; falling back to a cheaper route; the spend view for non-technical buyers; threshold alerts.

**Exit criteria:** acceptance criteria 7 to 10, tested under concurrency and under deliberately caused failures: killing the process mid-stream, making Postgres unavailable, and flushing Valkey. This milestone isn't done just because the happy path works.

**Watch out for:** this is the milestone most likely to be underestimated, because the feature looks small and the room for correctness bugs is large. Don't let it get squeezed.

### M5: Surfaces

**Status:** done. Gate: [docs/gates/m5.md](gates/m5.md).

**Goal:** chat and the OpenAI-compatible API over one policy path.

**Scope:** the OpenAI-compatible endpoint *first*; then chat, built as a client of it; the streaming UI; conversation management; model override with tracking; budget and fallback messages in the interface; attachments; compatibility testing against Open WebUI, LibreChat and both official SDKs.

**Exit criteria:** acceptance criteria 4 to 6 and 14 to 15. What matters most: below the transport layer, a chat request and an API request can't be told apart.

**Note on order:** building the API first is a deliberate constraint. If chat is built first, it will start reaching directly into internals, and the shared-path property will only exist on paper.

**Changed from this plan:** sharing conversations (CH-6, a SHOULD) was deferred, and retention, export and deletion of conversation history moved to M7 (ADR 0057).

### M6: Tools and MCP

**Status:** done. Gate: [docs/gates/m6.md](gates/m6.md).

**Goal:** tool access that's governed, not just available.

**Scope:** MCP client over stdio and Streamable HTTP; OAuth for per-user credentials; tool allowlists per workspace; approval steps with standing approvals; a dispatch layer that can separate execution into another process; iteration limits; delimiting untrusted content; a full audit of tool calls.

**Exit criteria:** acceptance criterion 18; per-user credentials shown working against a real MCP server; the dispatch layer proven by running one tool out of process, even though v1 ships them all in process.

**Changed from this plan:** per-user credentials are shown in CI with an unmodified Keycloak as the authorization server, in front of an MCP server of ours on the official server package, and the manual run against a public server (Notion's) connected accounts without running a tool (ADR 0074). The MCP surface through which MCP clients call Lakka is not built; it is v2, with the outbound MCP server (ADR 0066 Q1). Client-defined OpenAI tools are passed through to the client (ADR 0066 H4).

### M7: Observability and release hardening

**Status:** done. Gate: [docs/gates/m7.md](gates/m7.md).

**Goal:** someone who didn't build the product can run it and diagnose problems.

**Scope:** trace storage with partitioning and retention; the trace UI; content capture toggles and retention settings; OTLP export; usage analytics views; the diagnostics bundle; backup and restore; health endpoints; graceful shutdown; the AGPL source notice; documentation; the multi-arch release pipeline.

**Exit criteria:** every acceptance criterion in [docs/requirements.md](requirements.md) passes on a clean machine, run by someone following only the published documentation.

**Changed from this plan:** export and deletion of a person's data (NF-P4, ADR 0057, ADR 0082) and the multilingual classifier (ADR 0088) were added. Deployment under a subpath (NF-C4) and flagging an unsatisfactory reply (OB-7) were deferred to v1.x (ADR 0075). The release pipeline is built (ADR 0086); its first run published v1.0.0-beta.1.

### M8: Closing what v1 left open

**Status:** done. Gate: [docs/gates/m8.md](gates/m8.md).

**Goal:** finish the promises v1 made and did not keep, found in a documentation review, before the first release.

**Scope:**

- A per-person rate limit on model requests (BG-12), failing closed like budgets when Valkey is unreachable.
- Overridden messages offered to admins as route examples, while content capture is on (RT-10, ADR 0048).
- Rotating the credential master key (NF-S9, ADR 0038).
- The signed, opt-in price feed (PR-6, ADR 0037).
- An allowlist of the origins tools may reach, and stdio MCP servers moved into a sandbox with no network except through it (NF-S4). This brings the isolation part of the v2 sandbox forward; a code interpreter stays in v2.

**Exit criteria:** each item has its ADR, its requirement's Status reads `built`, and the tests named by its requirement ID pass, including the failure-injection tests for rotation, the rate limit and the sandbox.

**Changed from this plan:** the price feed was built dormant, with no public keys; the project owner added the primary and backup keys after the gate, then signed the first feed, `feed/catalogue-v1.json` (ADR 0116). The sandbox adds two services, `sandbox` and `egress`, nine in all, and needs Docker Engine 26 or later (ADR 0118). The items are ADRs 0113 to 0118.

### M9: The project site

**Status:** done. Gate: [docs/gates/m9.md](gates/m9.md). Deployed at https://lakka-ai.github.io/lakka/.

**Goal:** a public website for Lakka, published on GitHub Pages: a short landing page that says what Lakka is, what it promises, how to run it and where to read more, and the operator guide in `docs/guide/` as documentation with navigation and search. Both look like the app (ADR 0119).

**Scope:**

- A VitePress 2 package, `apps/site`, that reads `docs/guide/` in place, with no copy of the guide. Only the guide and the landing page, `docs/index.md`, are published; the specs, ADRs, design docs and gates are not.
- The Spruce theme's colours, typefaces, radii and focus rings on VitePress's own variables, in light and dark.
- Nothing loaded from a third party: local search, bundled fonts, no analytics.
- `pnpm site:check`: dead links and anchors, third-party resources, and axe on the landing page and the guide at desktop and phone widths, light and dark.
- A Pages workflow that builds and deploys the site.

Not in scope: a blog, a changelog page, versioned docs, translations, analytics, comments or newsletter forms, and any change to the product or its image.

**Exit criteria:**

- The landing page and every guide page build from `docs/` with no copy of the guide.
- The site uses the Spruce tokens and the app's typefaces in light and dark, and loads nothing from a third party.
- `pnpm site:check` passes: no dead links or anchors, no third-party resources, no axe violations on the checked pages at desktop and phone widths, light and dark.
- The Pages workflow is written and linted, and deploys the site once Pages is enabled for the repository with GitHub Actions as its source.
- The product image is unchanged.

**Changed from this plan:** at the project owner's request the landing page is the hero and the features only, and how to run it is left to Install; the guide's index, now What is Lakka?, opens an Introduction section, and the nav and the hero lead to it with one link, Docs. The product image gains one inert file, the site's VitePress patch (`patches/vitepress@2.0.0-alpha.20.patch`), because pnpm reads every listed patch before it installs; the project owner accepted it over a Dockerfile change (ADR 0120). The site's checks grew while the site was checked on phones and tablets: open menus, search, the 404 page, touch targets below 1024px, and the files the pages load; then every page at ten sizes from 320px to 2560px, the menus and search at each, a keyboard pass, and WebKit and Firefox beside Chromium, in a CI job of their own, `site`.

### M10: Routing accuracy

**Status:** done. Gate: [docs/gates/m10.md](gates/m10.md). Both architectures are gated in GitHub Actions. ADR 0122, ADR 0123, ADR 0124 and ADR 0125 are built and accepted. ADR 0123 and ADR 0124 were accepted with their amd64 measurements. mpnet missed the 100 ms gate on amd64, so it has a budget of its own, 200 ms at two threads on both architectures (ADR 0123).

**Goal:** raise routing accuracy where v1 measured it short, for routes with no examples yet and for languages other than English, without a new runtime dependency and without a second kind of model (ADR 0121), and ship only model weights whose publisher declares their license.

**Scope:**

- A route's description stands in for its examples until it has one (RT-12, ADR 0122): compiled when the policy is saved, on the route dialog and in Try a phrase.
- After that, the description counts as one of the route's examples, at every count (RT-12, ADR 0125): a third centroid source, existing centroids rebuilt in the background after the upgrade, the route dialog and Try a phrase saying so.
- paraphrase-multilingual-mpnet-base-v2 as a supported classifier the operator chooses, with MiniLM staying the default, both models in the one app image (ADR 0123).
- `DEFAULT_THRESHOLD_UP` from 0.25 to 0.30 for both models, with no migration of stored thresholds (ADR 0123).
- Both models' weights from sentence-transformers' own INT8 ONNX exports, one file per architecture, with the license text and an attribution for each model in the image (ADR 0124).
- The evaluation grows to match: the three blind description sets, the one-new-route rotation, the new route with 1, 2, 4 and 12 examples with and without its description, and both models evaluated offline on 2 CPUs in the image job and the release workflow, on amd64 and arm64.
- The guide: route descriptions, both models, accuracy per language with examples and with descriptions, latency, memory, and how to switch.

Not in scope: a decision model (ADR 0121), changing the default model, reading fewer than 128 tokens, weighting a description as more than one example, and migrating stored thresholds.

**Exit criteria:**

- ADR 0122, ADR 0123, ADR 0124 and ADR 0125 are accepted, ADR 0123 and ADR 0124 with their amd64 measurements.
- RT-12's Status reads `built`, and the tests named by RT-12 pass.
- Each image carries its architecture's sentence-transformers files, checked by sha256, and the models' license text; no Xenova file ships.
- The image job gates both models on both architectures: MiniLM at 80% in English and 75% in the other languages, mpnet at 80% in English and 78% in the other languages, each with same-language and English examples; `embed-bench` under 100 ms p95 for MiniLM at one and two threads, and under 200 ms for mpnet at two (ADR 0123). The release workflow checks the latency of the images it pushes, MiniLM at one thread and mpnet at two, and leaves accuracy to the image job, which runs on the commit it tags.
- With either model, the description fallback never does worse than no fallback, in any of the five languages, at the shipped thresholds: no more misroutes and no lower accuracy.
- With either model, in any of the five languages and for every blind description set, a description blended into a route's examples never does worse than the examples alone: the new route with 1, 2 and 4 examples, and every route described at 12 (ADR 0125).
- The images stay within NF-D6.

### Summary

| Milestone | Gate |
| --- | --- |
| M1 Spine and spikes | Isolation verified; both spikes proven |
| M2 Gateway | Cost accuracy |
| M3 Policy | Routing accuracy and latency |
| M4 Budgets | Can't be exceeded, even under failure |
| M5 Surfaces | Shared path proven |
| M6 Tools | Per-user credentials, approvals |
| M7 Hardening | Full acceptance pass |
| M8 Open promises | Each item built, with its ADR and tests |
| M9 Project site | Builds from docs/, no third-party requests, checked pages pass axe |
| M10 Routing accuracy | Both classifiers gated on both architectures; the description fallback never worse than none |

A milestone is done when its gate passes, not when a certain amount of time has gone by.

## Beyond v1

Kept thin on purpose. What comes after v1 should be decided by what real deployments do, not by what seemed likely a year earlier.

### v1.x: responding to first contact

This is reserved capacity, not a feature list. The first months after release are for deployment friction, compatibility gaps with MCP servers and client tools we haven't seen, performance on hardware we didn't plan for, and the operational problems that only show up in someone else's environment. Filling this window with planned features is how a self-hosted product gets a reputation for being fragile.

Multilingual classifier support is already in v1: the bundled model is multilingual, and routing is measured in German, French, Spanish and Swedish (ADR 0088).

Two v1 requirements are deferred to v1.x by ADR 0075: deployment under a subpath (NF-C4) and flagging an unsatisfactory reply (OB-7). Sharing conversations (CH-6) is deferred by ADR 0057, with no target set.

### v2 themes, roughly in priority order

**1. Knowledge.** Per-workspace knowledge bases on pgvector, with structure-aware chunking, hybrid retrieval and reranking. The reranker reuses the ONNX runtime that's already there, so the extra infrastructure cost is close to zero. It's the most requested capability in every comparable product and the one where the free alternatives are weakest: they have vector search, not good retrieval.

**2. Scheduled and durable agents.** Recurring runs with checkpoints at each step, resuming after a restart, human-in-the-loop pauses that survive the process dying, and per-run budgets. Chat platforms can't offer this, and workflow tools do it badly for AI in particular. It's also where the budget work from M4 pays off a second time.

**3. The evaluation loop and policy replay.** Automatically collect thumbs-down votes, retries and rephrasings into a regression set, then replay a proposed policy change against past traffic and report the difference in cost and quality. This is the defensibility argument from the strategy document turned into a real feature. It's third, not because it matters least, but because it needs a body of real traffic that only exists after adoption.

**4. Outbound MCP surface.** Expose a workspace's knowledge and tools to external MCP clients, under the same identity and policy. This completes the three-surfaces claim. In v1, Lakka is an MCP client only (ADR 0066).

**5. Sandboxed execution.** A code interpreter and other risky tools in a separate container with no network access by default. M8 brings the isolation forward for stdio MCP servers; this theme adds tools that run code.

Also deferred to v2 or later, outside this order: SSO and SAML beyond OIDC, and multi-instance or high-availability deployment ([docs/requirements.md](requirements.md), Deferred to v2 and later).

### Explicitly not on the roadmap

Repeated here because roadmaps are where non-goals get lost: visual workflow building, model serving, agent orchestration building blocks as a public API, model reselling, and any enterprise feature set (SAML edge cases, SOC 2, procurement support) unless customers who already pay ask for it.

### The hosting track

This depends on adoption, as decided in the strategy document. It's a separate track rather than a roadmap phase because most of it isn't product work: multi-tenancy, per-tenant isolation and resource limits, billing and metering, an operations setup with on-call, and a support commitment.

**The gate:** sustained adoption, with evidence that a meaningful minority would rather pay than run it themselves. Without that, this track doesn't start.

**The constraint to keep in mind:** a free, identical self-hosted edition puts a permanent ceiling on what hosting can charge. Hosting has to be worth paying for because of how well it's run (backups, upgrades, uptime, support), because it can never be worth paying for because of features. Any temptation to make the hosted version better than the self-hosted one would break the AGPL deal, and the community along with it.

## Release engineering

### Versioning and compatibility

Semantic versioning, with the contract spelled out, because self-hosted users upgrade on their own schedule and need to know what will break.

| Surface | Stability commitment |
| --- | --- |
| OpenAI-compatible API | Stable within a major version; only additive changes |
| Database schema | Forward-only migrations, applied automatically on start |
| Configuration | Environment variables are never removed within a major version; they're deprecated with warnings first |
| Internal packages | No stability guarantee; not a public API |

**Upgrade policy:** skipping minor versions has to work. Skipping a major version doesn't. Downgrading isn't supported and has to fail loudly on a schema mismatch rather than corrupt data, which is what AD-4 is for.

### Build and release pipeline

- Multi-arch images for `linux/amd64` and `linux/arm64`, published as a manifest list. Use native runners per architecture if emulated builds turn out slow. Buildx with QEMU is fine to start with, since the ONNX runtime ships prebuilt binaries per platform and nothing is compiled from source.
- **A Debian-based image, never Alpine.** There are no musl builds of the ONNX runtime, and building it from source in a Dockerfile is a wasted afternoon that comes back with every dependency update.
- Model weights baked into the image, which meets the offline-start requirement.
- CI runs the full acceptance suite on both architectures before publishing.
- An SBOM and provenance are attached to each release, and dependency and container scanning must pass before publishing.
- Release artifacts: the image manifest, a versioned compose file, and a migration note.

**Changed from this plan:** each architecture builds on its own native runner, and the release checks the pushed images (scan, size, offline embedding, the bundle's cold and offline start) rather than running the full acceptance suite, which CI runs on both architectures before a commit is tagged. The versioned compose file is a release bundle with every image pinned by digest, signed, with release notes generated from merged pull requests (ADR 0086, `docs/releasing.md`).

### Documentation as a release gate

A release isn't done when the code works. It's done when someone who has never seen the product can follow the published documentation to a working deployment. The minimum for each release: install, upgrade, backup and restore, a configuration reference, the AGPL notice and source link, and a troubleshooting page covering the problems support actually runs into.

This isn't thoroughness for its own sake. Documentation quality is the biggest factor in support cost, and support cost is the known threat to the economics.

### Schedule risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Budget correctness underestimated | M4 overruns and everything after it slips | Treat it as a correctness milestone, with failure-injection tests written before the implementation |
| Classifier underperforms in real use despite discovery | M3 delivers a feature users switch off | RT-11 makes turning it off a configuration change; explicit workspace routing is still useful |
| MCP OAuth support is thin in practice | TL-2 is only partly real | Fall back to shared credentials, show that in the audit trail, and document it honestly |
| Multi-arch CI friction | The release pipeline stalls late | Prove it in M1 as a spike, not at M7 |
| Streaming through the proxy misbehaves | The M2 gateway design keeps changing | Same approach: prove it in M1 before the gateway depends on it |
| Provider API changes | Gateway rework mid-build | Rely on the AI SDK's abstraction, and keep our own wrapper thin enough to absorb changes |
| Scope pressure from design partners | v1 never ships | The deferred list is the answer; partner requests go to v2 unless they block an acceptance criterion |
| Solo or very small team capacity | Everything slips in proportion | The milestone order is chosen so that stopping after M5 still leaves a coherent, useful product |

That last row is the most important thing about this plan. **M1 through M5 make up a shippable product**: governed chat and API with routing and budgets, but without tools or full observability. If capacity runs short, that's the release, and M6 and M7 become v1.1 and v1.2. A plan that only works if all seven milestones get finished isn't a plan for a small team.
