# 0091. The web patterns, their gallery, and where they depart from the boards

Status: accepted

## Context

- `docs/design/docs/patterns.md` names fifteen patterns to build once and reuse, with stories on the fixtures. The repository had no story tool.
- The patterns name the HeroUI v3 component each is built from. HeroUI 3.2.6 sets its own corners and button colors in its component styles, which the theme's variables do not reach.
- Three things came up while building them that the design does not settle:
  - Pattern 7 draws the share bar in a column of its own, aria-hidden, with no header text.
  - react-aria's Meter, under HeroUI's, renders `role="meter progressbar"`, and axe 4.13 reports its aria-value attributes on that fallback list.
  - HeroUI's tab list has a scroll shadow driven by a scroll timeline, which is always running.

## Decision

- **Storybook 10.6 is the gallery** (chosen by the project owner over a dev-only route). It is a dev dependency of `apps/web` with its own Vite config, since the app's runs TanStack Start. Telemetry, crash reports and update checks are off (invariant 8).
- **`pnpm test:stories`** builds Storybook and runs every story in Playwright, in light and dark, at 1280px and 390px. Each run fails on an axe violation, a console error, or sideways scroll at 390px. It runs in the CI check job and `ci:local`. `@storybook/addon-vitest` supports Vitest 3 and 4 only, and the repository is on 5.
- **HeroUI's component layer carries the design's corners and neutral secondary button** (`apps/web/src/styles/app.css`), after HeroUI's own rules, so a utility class on one element still wins.
  - Buttons and fields are 8px, cards and popovers 12px, dialogs 16px, alerts 10px, chips full.
  - `secondary` uses the text color, not the accent.
- **The share bar is inside the last cell**, aria-hidden, with the header's text set over the amount so it looks as drawn. A react-aria table cell cannot be hidden. A separate column was an empty cell that the arrow keys stopped on.
- **One axe exception**, in `test/axe.ts` and shared by the e2e suite and the stories: `aria-allowed-attr` on `role="meter progressbar"`, when only aria-value attributes are named. axe accepts the same attributes on `role="meter"`. The meter role and its aria-valuetext are required by `docs/design/docs/accessibility.md`, and react-aria gives no way to drop the fallback.
- **The settle wait** before axe, shared by both suites, counts only finite animations on the document timeline. It also waits for fonts and two frames.
- **Dialogs are bottom sheets below 640px**, where HeroUI's `placement="auto"` already puts them at the bottom. The sheet is styling on HeroUI's own Modal and AlertDialog, so their focus handling stays.

## Consequences

- Screens adopt the patterns when they are rebuilt. The older components (ErrorAlert, CopyField, the budget and delete dialogs) go when their last use does.
- A new axe exception needs a reason in `test/axe.ts` as narrow as this one. Anything else axe reports fails.
- Upgrading HeroUI means checking the overrides in `app.css` against its new component styles.
