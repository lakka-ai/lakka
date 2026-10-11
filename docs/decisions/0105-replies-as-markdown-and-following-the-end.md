# 0105. Replies as Markdown, and following the end of the thread

Status: accepted. Follows ADR 0061, which kept replies as plain text for now.

## Context

- Replies came out as plain text, with only fenced code blocks drawn apart. Models answer in
  Markdown, so lists, emphasis, headings and tables showed as raw symbols.
- A reply is model output, and may carry whatever a prompt or a tool result put into it. Drawing
  it must not let it run script, load anything, or reach the app's own api.
- The thread scrolled to its end on every new piece of a reply, so a person reading higher up
  was pulled down while the reply was still being written.
- The chat boards draw neither; the project owner asked for both.

## Decision

- **Parser.** `react-markdown` 10.1.0 and `remark-gfm` 4.0.1, both MIT, from the remark/unified
  project, in `apps/web`. They build React elements from the parsed text, so no HTML string
  reaches the page and nothing uses `dangerouslySetInnerHTML`. GFM adds tables,
  strikethrough, task lists and bare links. Your own messages stay plain text.
- **Safety** (`apps/web/src/components/chat/markdown.tsx`):
  - raw HTML in a reply is dropped (`skipHtml`);
  - a link works only for `http`, `https` and `mailto`, opens in a new tab, and has
    `rel="noopener noreferrer nofollow"`; any other address is shown as its text;
  - an image is never loaded: it becomes a link to its address, named by its alt text. Loading
    it would send what its address carries to whoever chose it, a known way for a manipulated
    reply to leak a conversation. The content security policy already blocks other origins'
    images;
  - a task list's box is drawn, not a form control, and says Done or Not done to screen readers.
- **Layout.** Headings start at level 3, under the page's h1. A table scrolls sideways in a
  focusable region named "Table, scrolls sideways", so the page never does at 390px. A single
  newline inside a paragraph stays a line break, as replies were shown before. Code blocks look
  as they did.
- **Following the end** (`apps/web/src/components/chat/follow-end.ts`). At the end, new text
  keeps the view there; a ResizeObserver on the content moves it before the frame is painted.
  Scrolling up stops that, and the view stays put while the reply goes on. Back at the end, by
  scrolling or with **Scroll to latest**, it follows again. Sending, or opening a conversation,
  always goes to the end. Within 48px of the end counts as at it.
- **Scroll to latest** shows only away from the end, centred just above the message box, 44px
  tall on a phone. It glides to the end, or jumps with reduced motion, and, since it goes once
  used, moves focus to the message box.

## Consequences

- The web image carries the two packages and their dependencies, about 98 small MIT and ISC
  packages, loaded with the chat page.
- A long reply is parsed again on each streamed piece. At chat lengths this is not noticeable;
  if it ever is, finished paragraphs can be cached.
- `segmentsOf` stays for your own messages, which keep their code blocks drawn apart.
