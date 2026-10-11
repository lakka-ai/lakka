# 0036. Provider adapter over the AI SDK provider packages

Status: accepted; ADR 0126 adds five hosted first-party providers over the OpenAI-compatible package.

## Context

The stack names the Vercel AI SDK as the provider layer, wrapped by our own thin gateway in core. The gateway must own retries, failover, the commitment window (ADR 0025) and cost accounting. Nothing may leave the instance except requests to model providers (invariants 8 and 12), and credentials must come only from our encrypted store (PR-2).

The AI SDK comes in two layers. The provider packages (`@ai-sdk/anthropic`, `openai`, `google` and `openai-compatible`) implement one model call against one provider's API. The `ai` package adds retries, multi-step tool loops, URL downloads, telemetry hooks and string model ids resolved through Vercel's hosted AI Gateway, whose client `@ai-sdk/gateway` it depends on.

## Decision

- **Core calls the provider packages directly**, at the single-call level (`model.doStream`), and does not depend on `ai`.
  - There are no hidden SDK retries or tool loops to switch off.
  - No hosted-gateway client is in the process at all.
  - URLs in messages are never fetched by the SDK.
  - A boundary test fails if `ai` or `@ai-sdk/gateway` is imported anywhere, or if any package other than core imports a provider SDK.
- **Settings are always explicit.** The SDK falls back to environment variables (`OPENAI_API_KEY`, `ANTHROPIC_BASE_URL` and others) for anything not passed. `languageModel()` always passes the API key and base URL, using our defaults for first-party providers. A connection without a key, or an OpenAI-compatible one without a base URL, is refused. A test sets hostile environment variables and checks they have no effect.
- **One interface per provider:**
  - OpenAI goes through the Responses API, OpenAI's current interface, which reports cached and reasoning tokens.
  - OpenAI-compatible endpoints go through chat completions with `include_usage` on, so streams report usage.
  - An OpenAI-compatible endpoint may have no key, as Ollama does, and then sends no Authorization header.
- **The normalized stream** has text deltas, reasoning deltas the provider chose to show, and a finish event with the finish reason and token usage. Usage keeps the SDK's split of uncached, cache-read and cache-write input tokens, and total and reasoning output tokens. A count the provider did not report is null, never zero. Everything else in the provider stream (metadata, warnings, sources, tool parts) is dropped until a milestone needs it.
- **Errors keep their data.** An HTTP error rejects the first read with the SDK's `APICallError`, keeping status and headers such as Retry-After for classification. An error inside the stream becomes `ProviderStreamError` with the provider error as its cause. Provider error messages can echo request content, so they are never logged (ADR 0005).
- **Stopping reading cancels the provider request.** This covers abort, failover and a caller that quits.
- **Dependencies:** the four provider packages and `@ai-sdk/provider`, all Apache-2.0. They bring `@ai-sdk/provider-utils` (Apache-2.0), `eventsource-parser` (MIT), `undici` (MIT), `@workflow/serde` (Apache-2.0, two symbol constants) and `json-schema` (BSD-3-Clause option). `undici` is loaded only for the SDK's download helper, which we do not call. Versions are pinned to releases older than the install guard's minimum age.

## Consequences

- Upgrading the SDK means upgrading provider packages only. Their stream part and usage types are what our adapter maps, and the fixture tests catch a changed wire format.
- Features that live only in `ai`, such as tool loops, structured output helpers and UI streams, are not available. Tools get our own dispatch seam in M6 (invariant 7), so this is intended.
- Reasoning models can spend a long time before their first text. Dispatch must set the first-chunk window per model instead of using one short timeout for all.
