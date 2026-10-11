# 0061. Chat in the browser

Status: accepted; widened by ADR 0092 (what a member sees of a cap); its plain-text replies are replaced by Markdown in ADR 0105.

## Context

- CH-1 to CH-4 and CH-7 ask for streaming conversations with history, renaming and model selection; which model answered and why; a model override that is recorded; the remaining budget and any fallback explained as it happens; and every error as a message the person can act on.
- The roadmap builds chat as a client of the OpenAI-compatible endpoint, so the shared policy path is real, not claimed (G5, ADR 0057). ADR 0059 put routing and budget decisions in response headers; ADR 0060 stores the history.
- A member could see only their own cap and their keys' caps (ADR 0049). What limits them is often the workspace or instance cap, which they could not see.
- The acceptance stack had no model provider, so nothing in the browser could get a reply.

## Decision

- **Chat is a client of `/v1/chat/completions`.** It sends the request an SDK sends, with the session cookie, `x-lakka-workspace` and `x-lakka-conversation`. It never calls anything chat-specific to reach a model. The body is the stored history, text only for now, with replies that produced no text left out, followed by the new message. `model` is the conversation's choice, or `auto`.
- **One page per workspace**, `/workspaces/:id/chat`, with the conversation in the search string (`?c=`). Starting a conversation creates it before the first message and replaces the URL, so the same component keeps streaming the reply.
- **Why a model answered (CH-2)** is written from the stored rule, route and fallback, in words: "You chose this model", "Routing matched the message to the Code route", "This is the workspace default model", and so on. While a reply streams, the same facts come from the response headers.
- **The model picker (CH-3)** lists what `/v1/models` lists: Auto, the routes, then the models. A pick is saved with the conversation (`model_choice`, ADR 0060) and applied at once, so a message sent before the save lands uses it. Sending a named model in a routed conversation is recorded as an override by the pipeline, as for any client (RT-10).
- **What is left to spend (CH-4)** comes from a new endpoint, `GET /api/workspaces/:id/budgets/remaining`.
  - It returns the least headroom among the caps the person's own requests count against (instance, workspace, member), which cap that is, and when it resets.
  - It shows a member the headroom of a workspace or instance cap, but not the cap's limit or spend. The headroom already shows through refusals, and hiding it would leave the person guessing.
  - It counts settled spend only; a request in flight is not subtracted until it settles.
  - Keys cannot call it, like the other budget reads (ADR 0049).
- **The fallback notice** is shown as soon as the response headers say a budget changed the model, before the reply text arrives, and stays with the stored reply afterwards.
- **Errors (CH-7):** each error code the endpoint sends has its own sentence, saying what happened and what to do. An unknown code gets a general sentence, never a status or a provider's text. A request refused before anything was sent stored nothing, so the message goes back into the box. A reply that breaks, or that the person stops, keeps what arrived and says so.
- **The reply stays on screen until it is stored.** After a stream ends, chat reloads the conversation until the stored reply for that request ID appears. `requestId` is added to the message view for this, so the reply never flickers or shows twice.
- **Accessibility:** the reply streams silently, and a status line says when it has finished or stopped. Errors use `role="alert"`, and the fallback notice uses `role="status"`. HeroUI's `Alert` sets no role of its own, so `ErrorAlert` now sets it for every error in the app.
- **A fake provider in the acceptance stack.** `docker/compose.e2e.yaml` runs the dispatch tests' fake provider (`test/integration/fake-provider.ts`) as a service, on the same Node image the app is built on, with only Node's own modules. CI starts the stack with it, and `pnpm test:e2e` expects it. It is never part of the customer's stack.

## Consequences

- Chat and an API client are the same kind of caller below the transport, which `surfaces.integration.test.ts` tests directly (AC 4, AC 5).
- A member sees why the model changed and how much is left without a support question. The trade-off is that members learn how much headroom the workspace and instance caps have left.
- Replies are plain text here. ADR 0062 adds attachments and ADR 0105 renders Markdown.
- A cap that an admin changes shows up in an open chat on the next page load, or within the query cache's 10 seconds.
