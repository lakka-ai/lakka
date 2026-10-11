# 0062. Attachments in chat

Status: accepted; extended by ADR 0106 (text files, dropping and pasting).

## Context

- CH-5 asks for file and image attachments where the chosen model supports them.
- ADR 0058 taught the gateway about images and PDFs, and dispatch passes over a candidate model that cannot read a request's files, then tries the next. ADR 0060 stores a new turn's files in `attachments`.
- Providers keep nothing between requests, so every later turn must send earlier files again (ADR 0057). If chat re-uploaded every earlier file on every turn, the requests would grow, and a few large files would reach the 32 MB body limit.
- Chat only knows which model will answer when the person names one. For a route, or for Auto, several models could answer.

## Decision

- **A file id refers to a stored file of the named conversation.**
  - In a request that names a conversation (`x-lakka-conversation`), a `file` part may give `file_id` instead of `file_data`: the id of an attachment in that conversation.
  - Core looks the ids up for the conversation's owner (`readConversationFiles`), and the API adapter puts the bytes in place before the request goes on. Budgets, dispatch and capability checks see an ordinary request.
  - An id from another conversation, from another person's, or of no file is refused with a 400 naming the part. Without a conversation header, a file id is refused, as before.
  - Only the newest turn is stored (ADR 0060), so files sent again by id are not stored twice.
  - This matches the OpenAI format's `file_id` field. There, the id names an upload in OpenAI's Files API; here, it names a stored attachment.
- **A `file` part may carry an image as well as a PDF.** OpenAI's `image_url` has no field for a file name, so chat sends every upload as a `file` part with `filename`. Images keep their names, which become the alt text. `image_url` still accepts only images.
- **What each choice can read.** A new endpoint, `GET /api/workspaces/:id/requestable`, lists what `/v1/models` lists, with `{images, pdf}` for each entry, for any member of the workspace:
  - **a model:** its own capabilities;
  - **a route:** what any of its model and fallbacks can read, since dispatch moves on to a candidate that can;
  - **Auto:** what any model it could pick can read. That is the pinned model if one is set; otherwise the default model, plus every enabled route when routing is on.
  - A conversation's earlier routing decision is not taken into account, so Auto can still be refused. The refusal is the plain sentence for `unsupported_input` (CH-7).
- **In chat:**
  - "Attach files" appears only when the current choice can read something, and the picker is limited to those types.
  - Before anything is sent, a file is checked for type, for whether the chosen model can read it, for the 10 MB limit per file and for the 20 MB limit per message. Any problem is a sentence naming the file.
  - Stored images are shown in place, and other files are download links. Both are served by the attachment endpoint with its defensive headers (ADR 0060).
  - Earlier files go by id on every later turn.

## Consequences

- A conversation's later turns stay small whatever its files. The API gets the same ability, for clients that send the conversation header.
- A person can switch a conversation to a model that cannot read its earlier files. The next message is then refused with a clear sentence, and the message is kept.
- Every turn of a conversation with files loads those files from Postgres. That is fine at the target size; a long conversation full of large files costs more on each turn.
- The web app sends no Content-Security-Policy of its own. Stored files are served with a sandboxing policy, but the page itself has none; that belongs to release hardening (M7).
