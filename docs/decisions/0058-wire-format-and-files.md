# 0058. The chat-completions wire format and files in the gateway request

Status: accepted

## Context

- API-1: implement `/v1/chat/completions`. API-6: an existing Open WebUI or LibreChat should work against it without changes. CH-5: file and image attachments where the chosen model supports them.
- M2's `GatewayRequest` carried text only. The provider packages accept files as inline data or as URLs, and a URL would make a provider package download it (ADR 0036 avoids that).
- ADR 0057 set attachment limits of 10 MB per file and 20 MB per message (Q2), and refuses tool calls until M6 (G6).
- The tech spec asks for capabilities to be checked before sending: a model that cannot handle the request's attachments is passed over, with the reason recorded.

## Decision

- **Content parts.** A message's content is plain text or a list of parts: `text`, or `file` with a media type, base64 data and an optional file name.
  - Files are PNG, JPEG, GIF, WebP images or PDFs. Anything else is refused at the edge.
  - Only user messages may carry files, which is what providers accept.
  - Limits are checked on the decoded size: 10 MB per file, 20 MB per message.
  - `textOf` and `filesOf` give surfaces and core one way to read content. Routing reads only the text.
- **Files go to providers as inline data**, never as a URL, so no provider package fetches anything on a user's behalf.
- **Capabilities are checked before sending.** A candidate without vision is passed over for an image, and one without PDF support for a PDF, and the request fails over as for any other skipped candidate. When no candidate can read the file, the request is refused with `unsupported_input` (422) and the reason.
- **Estimating files** (BG-2), since providers alone count them:
  - An image gets a flat figure, because providers charge a bounded amount per image: 1,600 tokens typical and 5,000 at the upper reading, above any common model.
  - A PDF is estimated from its size, one token per 100 bytes typical, and one per 25 bytes (at least 5,000) at the upper reading.
  - A typical estimate that is too low costs one failed-over attempt; an upper one that is too high reserves a little too much and is settled down to the actual cost.
- **Translating the OpenAI request** happens in the API surface, which stays an adapter (invariant 1).
  - It accepts `model`, `messages` (as text or `text`, `image_url` and `file` parts), `stream`, `stream_options.include_usage`, `max_completion_tokens` (preferred) or `max_tokens`, `temperature`, `top_p` and `stop`. `top_p` is new in the gateway request.
  - Other optional fields that clients commonly send are accepted and ignored, because refusing them would break clients (API-6): `user`, `seed`, the penalties, `logit_bias`, `metadata`, `store`, `n: 1`, an empty `tools` and `response_format: text`.
  - A `developer` message is treated as `system`.
  - Refused with a reason naming the field:
    - tools and functions, including assistant `tool_calls` and `tool` messages, until M6;
    - more than one choice;
    - structured output;
    - images or files by URL or by id;
    - unknown roles and content types.

## Consequences

- One request shape serves the API, chat and attachments. Budgets, routing and failover see files without special cases.
- Clients that send remote image URLs must send the image inline instead. Open WebUI and the official SDKs already send base64 data URLs for uploads.
