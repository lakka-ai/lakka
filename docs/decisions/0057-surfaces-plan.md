# 0057. Surfaces: conversation history, attachments, and the API's shape

Status: accepted; its G6 is lifted by ADR 0066 (H4).

## Context

- M5 builds the OpenAI-compatible API first and chat as a client of it (roadmap). CH-1 requires conversation history, and the tech spec stores it in a `messages` table.
- CLAUDE.md invariant 9 said prompt and response text is stored only in `span_content`, and only when the workspace opted in. As written, chat could not keep history, so the spec and the invariant disagreed.
- The M5 plan put these questions to the user, who chose the recommendations (Q1 to Q4) and approved the smaller decisions (G1 to G8).

## Decision

- **Conversation history is the user's data (Q1).**
  - Messages of a conversation are stored in `messages`, and their files in `attachments`, because the user asked the product to keep them (CH-1).
  - Retention (NF-P5) and export and deletion (NF-P4) arrive in M7.
  - A request that names no conversation, such as a plain API call, stores no text.
  - Logs, traces and telemetry stay free of content, as before. Invariant 9 is amended to say so.
- **Attachments live in Postgres (Q2):** a `bytea` column, up to 10 MB per file and 20 MB per message. Provider APIs keep no state, so a file is sent again on every later turn, and invariant 11 allows no other store.
- **Compatibility is tested in CI (Q3):**
  - the `openai` npm package, as a test-only dependency;
  - the official Python SDK, from a `python` container in CI only, not in the product;
  - pinned Open WebUI and LibreChat containers, driven against the stack with a fake provider.
- **Sharing conversations (CH-6, a SHOULD) is deferred past M5 (Q4).**
- **The API's shape:**
  - **G1:** `model: "auto"` runs the resolution order; `model: "route/<name>"` asks for a route (API-4); anything else names a model. `/v1/models` lists `auto`, the routes and the models the caller may use (API-2).
  - **G2:** a budget refusal is HTTP 402 with type and code `budget_exceeded`, which cannot be confused with a provider error (API-5). It is not 429, because the official SDKs retry 429s automatically. `budget_unavailable` stays 503. This settles F4 of the M4 plan.
  - **G3:** routing and fallback details travel in `x-lakka-*` response headers. The body's `model` is the model that answered, and no non-standard body fields are added.
  - **G4:** the API has no state by default; an optional `x-lakka-conversation` header joins a conversation, and chat always sends it.
  - **G5:** chat calls `/v1/chat/completions` with its session cookie, under the existing origin check.
  - **G6:** requests with tools or functions are refused with a clear 400 until M6.
  - **G7:** live streams subscribe to revocation events and end within seconds (AC 6).
  - **G8:** a non-streaming request is streamed from the provider as always and returned as one response, so budgets and the commitment window behave the same.

## Consequences

- Chat has history without a special case in the invariants, and API calls without a conversation stay text-free.
- Later ADRs build on these without reopening them, and cover what these leave open.
