# 0106. Text files, and dropping and pasting into chat

Status: accepted. Extends ADR 0062 (attachments in chat).

## Context

- Chat took files only through Attach files, and only images and PDFs (ADR 0062), which some
  models read and others do not.
- People drop files on the page and paste screenshots, files and long text into the message box.
  A long paste made the message, and later the conversation, hard to read.
- Notes, data and code are text, which every model reads, but text files could not be sent at
  all. Providers take plain text files in different ways, or not as files.
- The boards draw none of this; the project owner asked for it.

## Decision

- **Plain text is an attachment type**, `text/plain`, for chat and the API alike (one policy path,
  invariant 1).
  - It must be UTF-8. The contract refuses anything else with a 400 naming the part, before
    anything is sent or stored. A data URL's parameters, such as `charset=utf-8`, are allowed and
    ignored.
  - **The gateway gives it to every model as text** (`packages/core/src/gateway/text-document.ts`),
    in place of the file, delimited and named:
    `<document name="notes.md">` and the text, then `</document>`. No model is passed over for it.
  - **The budget estimate counts it as that text**, wrapping included, at both readings
    (ADR 0040), so a reservation is never below what it costs.
  - It is stored and served like any file: downloaded, never shown in the page, with `nosniff`
    and a sandboxing policy. Later turns send it again by id.
- **In chat** (`apps/web/src/lib/attachments.ts`):
  - **Text files of any kind** are sent as `text/plain` and keep their names. A file is text by
    its type (`text/*`, JSON, XML, YAML and similar) or, when the browser gives no useful type,
    by its name (`.md`, `.csv`, code). A text file that is not UTF-8 is marked with what to do.
  - **Attach files** is offered for every model now, with text files always accepted.
  - **Dropping**: files dropped anywhere on the conversation are attached, through the same
    checks as picked ones. While files are dragged over it, Attach files in the message box
    reads "Drop files to attach them". A drop elsewhere on the page is ignored, so the browser
    does not open the file and leave chat. Dropping is for a pointer; Attach files and pasting
    do the same by keyboard.
  - **Pasting** files, such as a screenshot or files copied in a file manager, attaches them.
    Copying a file also puts its name on the clipboard as text, and copying spreadsheet cells
    puts a picture of them beside their text, so files are attached only when the clipboard's
    text is empty or just their names; otherwise the text is pasted.
  - **A paste over 2,000 characters**, about a page, becomes a text document named "Pasted
    text.txt" ("Pasted text 2.txt" and so on), so the message stays short and the text arrives
    whole. Shorter pastes stay in the message box.

## Consequences

- Any model can be given notes, data or code as files, through chat or the API.
- A large text file can exceed a model's context window. The estimate catches it before
  sending, and dispatch fails over or refuses with `context_too_long`, as for long messages.
- Text in a document is the person's own content, delimited so the model can tell where it
  starts and ends. It is not treated as instructions from the system.
