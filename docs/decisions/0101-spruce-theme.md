# 0101. The Spruce theme

Status: accepted. Replaces the fonts named in ADR 0090.

## Context

The design bundle's Spruce variant (`docs/design/HANDOFF.md`, `docs/design/docs/tokens.md`) keeps
the screens, layout and copy, and changes two things:

- **The palette:** Spruce and Cloudberry in place of amber, in `docs/design/theme/lakka-theme.css`.
  It adds `--lk-cloudberry`, used only for the dot in the wordmark, which now sits on a Spruce tile.
- **The type:** Atkinson Hyperlegible Next for UI text and Atkinson Hyperlegible Mono for ids, keys
  and commands. Newsreader (`--font-serif`) is used, always regular, for:
  - page titles;
  - sign-in and setup headings;
  - the conversation title;
  - the Spent headline on the spend report.

## Decision

- **Theme file:** the app's `lakka-theme.css` is the bundle's file, copied as before; the
  theme unit test keeps the two identical.
- **Font packages:** `@fontsource/atkinson-hyperlegible-next` (400, 500, 600, 700),
  `@fontsource/atkinson-hyperlegible-mono` (400, 500) and `@fontsource/newsreader` (400). They
  replace `@fontsource/schibsted-grotesk` and `@fontsource/ibm-plex-mono`. All are OFL-1.1 and
  bundled, never loaded from a CDN (NF-P1).
- **Static Newsreader:** not the variable font, because the theme names the family "Newsreader".
  It renders at one optical size, where the boards preview Google Fonts' optical-size axis.
- **Type classes:** two classes in `app.css` set the type scale's Newsreader sizes.
  - `lk-title` is for page titles: 26px on a phone and 30px from the desktop layout up. The
    request trace title is 28px, as drawn.
  - `lk-headline` is the 34px Spent figure. The member's "You spent" stays in the sans, as the
    Spend-Member board draws it.

## Consequences

- The web image carries the new font files instead of the old ones.
- Contrast is the bundle's measured set (`tokens.md`); the theme file is not edited by hand.
