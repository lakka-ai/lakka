# 0060. Conversations and their history

Status: accepted

## Context

- CH-1 asks for conversations whose history the user keeps; CH-3 for renaming and deleting them and choosing a model per conversation; CH-5 for files in a message.
- ADR 0057 (Q1, Q2) settled that history lives in Postgres as the user's own data, with files as `bytea` (10 MB per file, 20 MB per message), and amended invariant 9: text is stored in `messages` only for a request that names a conversation.
- M3 already had a `conversations` row per routed conversation, holding the routing decision (RT-11). The header `x-lakka-conversation` (G4) joins one from the API.

## Decision

- **Schema** (migration 0013):
  - `conversations` gains `title` (up to 200 characters, empty until known) and `model_choice` (`auto` when null, otherwise a model reference or `route/<name>`, the same values as the API's `model` field). The UI reads it; requests still say what they want.
  - `messages`: role `user` or `assistant`, text, the request it came from, and a state: `complete`, `interrupted` (the stream broke) or `aborted` (the client went away). An assistant message records the model that answered, the routing rule, the route and the model a budget fell back from, so the chat can say why (CH-2).
  - `attachments`: media type, file name, size, the bytes and their position in the message.
  - Both carry `workspace_id` and cascade from their conversation.
- **Only the owner.**
  - Every query is scoped by workspace and the owning person (a key's owner, invariant 2).
  - Anyone else, admins included, gets 404 for another person's conversation, on the management endpoints and on `/v1` with the header (AC 16). Seeing someone's history is an audit feature for later milestones, not a side effect of being an admin.
  - Managing conversations needs `models.use` in the workspace.
- **Endpoints:** `POST`, `GET` (a list, newest change first), and `GET`, `PATCH` and `DELETE` on one, under `/api/workspaces/:workspaceId/conversations`. `GET .../attachments/:attachmentId` returns a file.
- **Recording happens in the entry point**, so every surface records the same way (invariant 1):
  - After dispatch has accepted the request (budget reserved, provider committed), the last message is stored if it is the user's, with its files. A refused or failed request stores nothing.
  - The conversation's title, while empty, becomes the opening words of that text (up to 60 characters), or else the first file name.
  - When the stream ends, the reply is stored with what arrived and its state. It is written after the budget is settled, so a slow write never holds a reservation.
  - The client sends the whole history each time, as the OpenAI format requires. Only the newest turn is stored, so a client that edits earlier turns does not rewrite what was kept.
  - A failure to record is logged by request ID, without content, and does not fail the request: the user already has the answer, and the budget is already right.
- **Files are served defensively.** The stored media type, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`, `cache-control: private, max-age=0`, inline only for images, and a sanitized file name. A stored file cannot run script in our origin.

## Consequences

- Chat and any API client that sends the header get the same history, and the history says which model answered each turn.
- Deleting a conversation deletes its messages and files at once. Usage and traces keep their request IDs and costs, not the text.
- Files live in the main database. At the target size that is fine; backups grow with it, which the operator docs will say (M7).
- A client that sends a conversation ID but rewrites earlier turns keeps two views of the history: its own and ours. Ours is what the user saw answered.
