# 0059. The OpenAI-compatible endpoints

Status: accepted

## Context

- API-1 to API-5 ask for `/v1/chat/completions` (streaming and not), and for `/v1/models` listing only what the caller may use. They require the same policy path as chat, an optional route name, and a budget refusal that can be told apart from provider errors.
- ADR 0057 settled the shape: the `model` field (G1), 402 for budgets (G2), decision headers (G3), a conversation header (G4), session auth for chat (G5), no tools yet (G6), and non-streaming built on streaming (G8). ADR 0058 settled the request format.
- Spike B (ADR 0025) proved streaming through Caddy: commit on the first chunk, flush without buffering, and abort on disconnect.

## Decision

- **One adapter, both credentials.**
  - Both endpoints accept a bearer key or the session cookie, under the existing origin check. A key's requests are the `api` surface, a signed-in person's the `chat` surface (G5).
  - The request translates to `ModelRequest` and calls `handleModelRequest`, like every surface (invariant 1, API-3).
- **Workspace:** a key acts in its own workspace. A person names one in `x-lakka-workspace`, or it is their only workspace. Someone in several must name one, and is told so.
- **The `model` field (G1):**
  - `auto` runs the resolution order.
  - `route/<name>` resolves to that enabled route's model and fallbacks, as the caller's own choice (rule `explicit`, with the route recorded).
  - Anything else names a model.
  - An unknown model or route is a 404 `model_not_found`.
  - In a routed conversation, a named route with a different model is an override, like a named model. Override detection now compares the resolved model with the conversation's, after resolution.
- **`/v1/models`** lists `auto`, then `route/<name>` for each enabled route, then the models the workspace can call (priced, with a credential), in the OpenAI list shape (API-2).
- **Streaming** follows the commitment window.
  - Nothing is sent until the first chunk is in hand, so an earlier failure is an ordinary JSON error with its real status.
  - Then come chunks: a first delta with the role, content deltas, a chunk with the finish reason, a usage chunk when `stream_options.include_usage` is set, and `data: [DONE]`.
  - A later failure ends the stream with an error event (`stream_interrupted`), and there is no `[DONE]`.
  - A client that disconnects aborts the request, which is settled with its partial usage.
  - On shutdown, open streams end with `server_shutting_down`.
  - Reasoning the model shows is not sent; it is not part of the standard format.
- **Non-streaming** collects the same stream and returns one `chat.completion` (G8). A stream that breaks is a 502 `stream_interrupted`.
- **The `model` in every response** is the model that answered, after routing, fallback and failover. Headers carry the rest (G3): `x-lakka-request-id`, `x-lakka-model`, `x-lakka-routing-rule`, `x-lakka-route`, `x-lakka-routing-reason`, and `x-lakka-fallback-from` with `x-lakka-fallback-scope`.
- **Errors** use the OpenAI shape `{error: {message, type, param, code}}`, with messages written for the caller, never a provider's raw body (CH-7):
  - `budget_exceeded` is 402 with type `budget_exceeded` (G2);
  - `budget_unavailable` is 503;
  - a bad key is 401 `invalid_api_key`;
  - validation is 400 with the `param` it concerns;
  - a context overflow is `context_length_exceeded`;
  - a content filter is `content_filter`;
  - provider failures are 502.
- **Body limit:** the chat endpoint accepts bodies up to 32 MB, room for 20 MB of files in base64. Caddy sets no lower limit.
- **Spike B's routes stay** while they are the only CI check of streaming through Caddy. Once the compatibility job streams real completions through it, they are removed (ADR 0064).

## Consequences

- Scripts, the official SDKs and chat reach models through one endpoint and one policy path. Usage records which surface a request came from.
- A client sees which model answered, and can read why from the headers, without non-standard body fields.
