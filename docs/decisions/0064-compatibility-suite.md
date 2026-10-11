# 0064. The compatibility suite

Status: accepted. The Spike B files and variable it removes no longer exist.

## Context

- AC 14: an unmodified Open WebUI configured against the endpoint can list models and hold a streaming conversation, subject to our budgets and policy.
- AC 15: the official OpenAI SDKs for Python and TypeScript work without special handling.
- API-6 asks for Open WebUI and LibreChat to be tested specifically. The tech spec calls this contract test a gate, not a hope.
- Q3 of the M5 plan (ADR 0057) chose the approach:
  - the `openai` npm package as a test-only dependency;
  - the Python SDK from a `python` container in CI only;
  - pinned Open WebUI and LibreChat containers against the stack with a fake provider.
- Spike B's routes (ADR 0025) were kept only until real completions streamed through Caddy in CI (ADR 0059). Its shutdown check used them too.

## Decision

- **One running stack, clients from outside it.** Every check talks to the compose stack as a customer's clients would: through Caddy, with only a base URL and a key. The stack runs with the fake provider (`docker/compose.e2e.yaml`, ADR 0061).
  - `pnpm test:compat` prepares it (`test/compat/global-setup.ts`): an instance admin, a workspace of fake-provider models with a code route, a key, and a second workspace whose one-micro-dollar cap refuses everything.
  - It writes the result to `test/compat/.state.json`, which is git-ignored and readable only by its owner, for the checks that are not TypeScript.
- **The TypeScript SDK** (`openai` 7.23.0, Apache-2.0, a root devDependency; `test/compat/typescript-sdk.compat.test.ts`):
  - listing models;
  - a completion with the decision headers;
  - streaming with a usage chunk;
  - unbuffered streaming through Caddy: 40 chunks 25 ms apart must spread over more than 600 ms, not arrive together;
  - `auto` and `route/<name>`;
  - an inline image;
  - a budget refusal as a 402 that the SDK sends once and does not retry, counted with the SDK's own `fetch` option;
  - a bad key and an unknown model as the SDK's own error classes;
  - a stream broken mid-way raised as an error.
- **The Python SDK** (`openai` 3.19.2, pinned in `test/compat/python/requirements.txt`; `check_sdk.py`) runs the same checks from `python:3.13.9-slim-trixie` on the compose network (`pnpm test:compat:python`). The product still has no Python runtime.
- **Open WebUI and LibreChat** (`docker/compose.compat.yaml`, `pnpm test:compat:apps`), pinned by digest, run unmodified with only configuration:
  - **Open WebUI** v0.11.4-slim (BSD-3 with a branding clause), with sign-in off, Ollama off, offline mode on, and the generation extras off.
  - **LibreChat** v0.8.7 (MIT), with MongoDB 8.0.20, Lakka as a custom endpoint (`docker/compat/librechat.yaml`), model fetching on, and a fallback model name the checks require to be absent.
  - Their secrets are random per run.
  - Both are driven through their own HTTP APIs, the ones their interfaces call, so the requests Lakka receives are made by their code:
    - models listed from `/v1/models`;
    - a two-turn streamed conversation;
    - for Open WebUI, `auto` routing code to the code route;
    - for both, a refusal once the workspace cap is set below one request.
  - LibreChat refuses chat requests without a browser User-Agent, so its checks send one.
  - The LibreChat image is Alpine-based. The no-Alpine rule is about our images; this is a third party's product, run only in CI.
- **Spike B is removed:** its routes, `LAKKA_ENABLE_SPIKE_ROUTES`, `docker/compose.spike.yaml`, `scripts/spike-sse.ts`, `pnpm spike:sse` and their unit tests. What it proved is now checked with real completions:
  - unbuffered streaming, by the SDK checks above;
  - the commitment window, by the gateway and `/v1` integration tests;
  - shutdown, by `scripts/compat-shutdown.sh`, which stops the api under an open completion stream through Caddy, expects `server_shutting_down`, and requires the api to be gone within 5 seconds.
- **A shutdown fix this found.** A stream aborted at shutdown became an idle keep-alive connection just after the server had closed its idle connections, so the api waited for the keep-alive timeout. The forced close hid this until 5 seconds had passed. Shutdown now waits, for at most 2 seconds, until aborted streams have written their last bytes before the server closes connections. An integration test covers it.
- **In CI:** the stack job runs the SDK checks and the shutdown check on both architectures, and the Open WebUI and LibreChat checks on amd64, on every pull request. All run after the acceptance suite.

## Consequences

- Compatibility is a gate on every change, measured with the real clients rather than our reading of the OpenAI format.
- Upgrading a pinned client is a deliberate change with its own review. The LibreChat and Open WebUI APIs the checks drive change between versions, so an upgrade may need the checks adjusted.
- The stack job pulls about 1 GB more on amd64 and takes a few minutes longer.
