# 0112. The markup sweep: one way for empty lists, code, icons and focus

Status: accepted. Follows the audit in `docs/design/docs/markup-sweep.md`. Changes
ADR 0108 (code blocks, which now include tool arguments), and amends patterns.md and tokens.md.
The sweep file was later folded into patterns.md and tokens.md and removed.

## Context

- The markup sweep audited every component, route and pattern in `apps/web`
  against HANDOFF.md, patterns.md, tokens.md, phone.md and ADRs 0107 to 0111, and HeroUI 3.2.6
  as installed. It found the same thing done several ways (empty lists four ways, code blocks
  six, focus rings three), overrides of HeroUI that never applied, and a few accessibility gaps.
- Some fixes needed choices the design docs do not make. The project owner made them.

## Decision

- **Empty lists** are said one way everywhere: `EmptyList`, one muted line at most 780px wide,
  inside its card under the header, or in a card of its own where the list has no card. Nothing
  yet and nothing matching a filter read the same. DataTable no longer draws an empty state.
  `EmptyState` stays for a page with nothing yet; it is not a list.
- **Code blocks** all scroll sideways and keep their indentation, as ADR 0108 decided for code:
  tool arguments, a tool's result and what a trace recorded too, which used to wrap. `CodeBlock`
  is the one block: mono 13/20, 10px 12px in, 8px corners, focusable because it scrolls.
- **Icons** are 16px, and 18px below 1024px, through `--lk-icon`, Icon's default size, as
  phone.md asks. Icons that are smaller on purpose (chips, inline rows) keep their size.
- **Mono text** is 13px in a line of text and 12px in a 12px line (tokens.md). Mono in a field
  keeps the field's size, so a phone does not zoom in on it.
- **Sizes outside the type scale**, documented as exceptions: the wordmark (18px, as drawn), the
  conversation title (Newsreader 20px, 18px on a phone, as Chat-Desktop and Chat-Phone draw
  it), inline code in a reply (0.9em of the message), and the setup recovery key (17/28).
- **Caption** is 500 for chips and table headers, 400 for secondary lines, and group headings
  (the Admin menu heading, the conversation date groups) are 600. tokens.md says so.
- **Buttons**: a full-page form (a sign-in provider) keeps md buttons, Pattern 13's footer rule.
  Jump to latest, not drawn on any board, floats over the conversation as a popover does, so it
  keeps its overlay shadow and full corners. The design's secondary button is HeroUI's
  `tertiary` variant (the same fills, the current text color), so no override is needed.
  HeroUI's unused button, toggle and tag sizes stay defined as the scale (ADR 0108).
- **Headings in chat** start at h2 under the conversation title: a reply's Markdown, a tool call
  and an approval card. A reply's tables are numbered in their region names ("Table 2, scrolls
  sideways"), so two never share a name.
- **New conversation** is a link drawn as a button: it goes to an address.
- **Fields under a radio** sit in `RadioDetails`, inside the RadioGroup, right under their option
  as Tools-Add draws them. It keeps the arrow keys in the field, which the group would otherwise
  take to move between radios.
- **The message box's focus ring** shows only while the box has focus, not while Attach or Send
  does.
- **A disabled option's reason** is not dimmed: a disabled radio's control and label are at 50
  percent, and its description, which says why, keeps full contrast.
- **Overriding HeroUI**: HeroUI's component CSS is in `@layer components`, so a utility already
  wins and `!` is never needed against it. app.css keeps rules outside the layers only where a
  HeroUI selector is more specific. Where HeroUI reads a variable at run time, the app sets the
  variable (`--container-lg` for the dialog width, `--radius-3xl` for overlay corners) instead of
  overriding each selector.
- **Shared classes** in app.css name what was written out as utilities: `lk-card`, `lk-focus` and
  `lk-focus-inset`, `lk-popover-fit`, `lk-skip-link`, `lk-pill-panel`. CardSection takes a
  `badge` and `CardInset`.

## Consequences

- Recorded prompts are prose, so a long paragraph is one long line that scrolls sideways. If that
  reads badly in use, the trace page's blocks are the place to revisit.
- Tables, dialogs and invalid fields now match the spec: rows 2px taller (15px text on a phone),
  every dialog 28px shorter, an invalid field's edge 2px. md button text is 14px on a phone.
- The e2e tests find New conversation as a link, and a reply's headings and first table at their
  new levels and name.
