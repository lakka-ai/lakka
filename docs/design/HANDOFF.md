# Lakka web app: design handoff (Spruce palette)

Read this file first. It is the entry point and it overrides anything you infer from the mockups.

This bundle is the Spruce variant of the design: the same screens, layout and copy as the first version, with the Spruce and Cloudberry palette (near-gray neutrals with a trace of spruce), Atkinson Hyperlegible Next and Mono, and Newsreader for titles. If you also have the first bundle, do not mix the two. Use one theme file.

## What you are building

Lakka is a self-hosted AI control plane for teams of 10 to 50 people. People chat with models, admins set budgets and routing, and every request can be traced. This bundle is the approved UI design. The front end in the repository's `apps/web` is built from it with HeroUI v3 (React) and the theme in `theme/lakka-theme.css`. Every change to `apps/web` keeps it matching this bundle.

The app's stack is TanStack Start and TanStack Router with HeroUI v3 (the repository's `CLAUDE.md`). Follow it. The theme file is copied to `apps/web/src/styles/`, because the image build does not see `docs/`, and a unit test keeps the two identical (ADR 0090).

## Source of truth, in order

1. This file.
2. `docs/patterns.md`: the 15 patterns. Build each one once as a shared component and reuse it.
3. `docs/screens.md`: every screen, its route in the app, its states and which mockup shows it.
4. `docs/accessibility.md`: keyboard and screen-reader requirements per screen.
5. `docs/phone.md`: how every screen adapts at 390px wide.
6. `docs/copy.md`: rules for all UI text.
7. `docs/tokens.md`: token reference, the type, spacing, radius, border and shadow scales, mockup-to-theme token names, measured contrast.
8. `mockups/static/`: the drawn boards as HTML you can open. Use them for layout, spacing, hierarchy and exact copy.
9. `docs/fixtures.md`: the sample data that runs through every board. Use it for stories, tests and seed data.
10. `docs/open-questions.md`: decisions that are not made yet, what has no board, and what has been settled since. Do not guess the open ones. Build the recommended option only where the file says so, and ask about the rest.

If two sources disagree, the higher one wins. Raise the conflict with the maintainers.

The repository's ADRs (`docs/decisions/`, from ADR 0090) record what was decided while building the app, where the bundle left it open or the backend works differently. These docs follow them, and name the ADR where a rule comes from one.

## How to read the mockups

- Look at `mockups/static/`. Each board is a plain HTML snapshot you can open or screenshot. `mockups/static/index.html` lists them by area. When `docs/` names a board, such as `Admin-Models.html`, it is the file of that name in `mockups/static/`.
- They are mockups, not code to ship. Styling is inline and duplicated. Rebuild with HeroUI components, the theme tokens and your own shared components.
- DO copy the visible text exactly. The copy was reviewed line by line.
- DO copy the semantic markup choices: headings, landmarks, labels, aria attributes, button vs link.

## Hard constraints

These came from the product brief and are not negotiable. Treat a violation as a bug.

- WCAG 2.1 AA in light and dark.
- No telemetry, analytics or error-reporting SDKs. No request to any third-party host at runtime.
- No CDN assets. Bundle Atkinson Hyperlegible Next, Atkinson Hyperlegible Mono and Newsreader (all OFL) with the app, for example with @fontsource. The mockups load Google Fonts only for preview. Production must not.
- The app is AGPL. The "Source code" link and the line "Lakka is free software under the AGPL." are to move to a Settings page that is not designed yet. Until it exists, they are the first item of the account menu on every signed-in page (full menu, rail and phone drawer), and the footer of the signed-out pages: setup, sign in, invites and reset links (ADR 0107). Never ship a build without the source link: see `docs/open-questions.md`.
- Secrets (setup recovery key, API keys, invite links, webhook signing secrets) are shown exactly once, in the one-time secret dialog (Pattern 5).
- Stored credentials are write-only. The browser never receives a stored secret. The field stays empty and says a key is set (Pattern 6).
- Tables are real tables. Share-of-total bars are decorative and aria-hidden (Pattern 7).
- Charts are optional and always have a table view with the same numbers.
- Every screen works at 390px wide with no horizontal page scroll.
- Members never receive admin-only data from the server. Hiding it in the UI is not enough.
- All UI copy is ASCII-only plain English. See `docs/copy.md`.

## Theme

- Load `theme/lakka-theme.css` after the HeroUI styles. It sets HeroUI v3 variables for light (`:root`, `.light`, `[data-theme="light"]`) and dark (`.dark`, `[data-theme="dark"]`).
- Everything Lakka-specific is prefixed `--lk-`. The mockups use some shorter names. Map them with the table in `docs/tokens.md`.
- The focus color is blue on purpose. Do not change it to the accent.
- Soft color variants are set by hand, not derived with color-mix(), because the derived foregrounds were not checked for contrast.
- The selected pill needs the outline rule at the end of the theme file. Without it the selected state fails WCAG 1.4.11.

## HeroUI

The patterns name the HeroUI v3 components each one is built from (Chip, Popover, Meter, Alert, AlertDialog, Modal, InputGroup, TextField, Checkbox, Select, Switch, Table, Tabs, Card, Disclosure, Button). Check the HeroUI v3 docs for exact APIs. If a named component does not exist in the installed version, or cannot meet an accessibility note, stop and raise it with the maintainers. Do not quietly hand-roll a replacement. How the app overrides HeroUI's own styles is in `docs/patterns.md` (Building on HeroUI).

Phone dialogs are drawn as bottom sheets. Below 640px HeroUI's `placement="auto"` already puts a Modal or AlertDialog at the bottom, so the sheet is styling on HeroUI's own dialogs and keeps their focus management (ADR 0091).

## Done means

For each screen:

- It matches its mockup in layout and copy, in light and dark.
- It meets its notes in `docs/accessibility.md`: keyboard pass, screen-reader names, focus order, and focus return from dialogs.
- An automated accessibility check reports no violations: `pnpm test:stories` runs axe on every story in light and dark, at desktop width and 390px (ADR 0091), and the e2e suite runs it on the pages.
- At 390px wide it follows `docs/phone.md`, and the page never scrolls sideways.
- `pnpm check:copy` passes on the source (the repository's `scripts/check-copy.sh`; `scripts/check-copy.sh` in this bundle runs the same one).
- The network panel shows no request to any host other than the app itself.
