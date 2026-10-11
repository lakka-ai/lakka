# 0108. Aligning the web app with the design audit

Status: accepted; its lg buttons are changed by ADR 0111, and its code blocks by
ADR 0112. Changes ADR 0107 (rail heights), and the disabled and focus states chosen before it. The
audit file was later folded into patterns.md and tokens.md and removed.

## Context

- Design's consistency audit (docs/design/docs/audit.md) snapped every board to one
  set of scales: the type scale, spacing, radius, borders and shadows in tokens.md, one size per
  control and one set of states in patterns.md, and a one-step-larger type on phone (phone.md).
- An audit of the app against it found that the theme colors match exactly, and that most
  differences are sizes: the app has no type or size tokens, and uses HeroUI's defaults and
  arbitrary values instead.
- Some audit rules reverse decisions recorded in commits or ADRs: disabled buttons drawn as a
  dashed outline, a 1px focus offset on fields, 3px checkbox corners, the pill group's 4px
  padding and 12px corners, and the rail heights in ADR 0107.
- Some boards disagree with each other or with the docs: button sizes (36px in patterns.md, 30px
  row buttons on the boards), dialog widths (448px rendered; 520 to 720px drawn), the outline
  button's border color, the meter height, the trace chip size and the phone spend headline.

## Decision

The project owner settled the reversals and the conflicts:

- **Disabled** is 50 percent opacity with a not-allowed cursor, as patterns.md says, on every
  control. aria-disabled stays where a control must remain focusable to say why. A read-only field
  keeps its value readable: a `--surface-secondary` fill, muted text and a solid `--border` edge.
  Dashed borders are only for optional-step markers (tokens.md).
- **Focus** is a 2px `--focus` outline with a 2px offset on every control, fields included.
- **The audit's size changes are adopted as one block**: tables 14 / 12 / 10x12, info notes 14,
  the 12.5 and 11.5 sizes to 12, dialog fields 16 apart, checkbox corners 4, segmented controls
  with 2px padding and 10px corners, ledes 780 wide, public and setup cards 32 with a 30px title,
  and the phone step-up (body 15, labels and descriptions 14, card titles 17, stat 22, chips 28
  by 13, fields 44).
- **Rail heights** are the design's: the workspace switcher 48px, Chat 40px, the account row 48px.
  This replaces "Same heights" in ADR 0107; the rest of ADR 0107 stands.
- **The account row** shows the email under the name, as drawn. `/api/me` returns the person's
  own email for it.
- **New conversation** is a primary button, in the list and in the phone drawer.
- **Code blocks keep scrolling sideways** for long lines instead of wrapping, so code keeps its
  indentation. They take the drawn 10px 12px padding and 8px corners.
- **Buttons are the same size at every width**, phone included: 32px (md), or 40px (lg) for a
  page's, card's or list's main action and a button beside a field (see Consequences). This
  replaces patterns.md's 36px and phone.md's 44px for buttons; fields, tabs and rows keep their
  own heights.
- **Dialogs are one size**: 720px wide, or the viewport less 32px. Below 640px they stay bottom
  sheets (ADR 0091).

Where the boards disagree, the higher source in HANDOFF.md wins and the shared pattern is reused:

- The outline button's border is `--border` (tokens.md). `--field-border` is for things a person
  types into or toggles.
- The routed chip says the route only ("Code route"), since a chip stays under 16 characters
  (Pattern 1); the confidence is in the popover.
- The meter track is 6px (patterns.md).
- Every chip is the one Chip size, the trace outcome chip included: 24px by 12px, and 28 by 13
  on phone.
- The spend headline is the display style, Newsreader 34, at every width.
- Public and setup cards are 24px in from the edge on phone, the usual card padding.
- The line under the Workspaces table says "Spend matches Instance spend." only while that is
  true. Once a deleted workspace has spend this month, it says how much: "Instance spend also
  includes $X.XX from deleted workspaces."

## Consequences

- The type scale, radius 10, and the control sizes become tokens and shared CSS in
  apps/web/src/styles/app.css, so a screen names a role (`text-body`, `rounded-note`) instead of a
  pixel value.
- "One size" is reached through HeroUI's size variants, not by overriding them all to one value.
  Each variant takes its own values from tokens (buttons and toggle buttons --sm 28, --md 32,
  --lg 40; the md chip, tag and switch as drawn; the lg dialog 720px wide), and an element asks
  for the size it needs: every chip, tag and switch is md, every dialog lg. Buttons take two
  sizes, chosen by the project owner: lg (40px) for the main action of a page, a
  card, a list or an empty state (Create workspace, Add a route, Set a workspace cap, Save in a
  settings card, New conversation), for a button beside a field (Try, Add domain, Create key,
  Add a fallback), and for every button on the sign-in, setup, invite and reset pages; md (32px)
  for every other button, such as dialog footers, row and table
  actions, notice actions, icon buttons and the message box's. Flat cards
  come from --surface-shadow set to none, not from removing the shadow per component.
- patterns.md and phone.md are amended where the decisions above differ, so the design docs and
  the code agree.
- The e2e suite's rail comparison moves to the new heights.
