# Tokens

The full set is in `theme/lakka-theme.css`, as HeroUI v3 variables, for light and dark. This page covers what the CSS file cannot say.

## Palette

The colors start from the Spruce palette sheet. Grounds, surfaces, lines, fields and text are near-gray: each keeps the sheet's lightness, with about a third of its chroma, all at the spruce hue (OKLCH hue 165). The tint shows only next to a true gray. Spruce, its soft fill, the state colors and cloudberry keep their full color. Where a swatch failed WCAG 2.1 AA for its job, a darker shade does that job.

| Sheet name | Sheet value, light / dark | Used, light / dark | Tokens |
|---|---|---|---|
| Mist | #F3F5F1 / #131A17 | #F3F5F4 / #171918 | --background |
| Panel | #FFFFFF / #1B2420 | #FFFFFF / #202221 | --surface, --field-background |
| Line | #DCE2DD / #2F3B36 | #DEE1E0 / #353937 | --border (dark: also --lk-chart-grid) |
| Field | #83938C / #6F7F78 | #838886 / #777C7A | --field-border |
| Ink | #1B2622 / #E7EDE9 | #212423 / #EAECEB | --foreground |
| Lichen | #56645E / #A0ADA7 | #5D615F / #A7AAA8 | --muted |
| Spruce | #2A5245 / #9CCBB8 | same | --accent, --link, --lk-chart, --lk-decision-routed |
| Cloudberry | #E3A33F / #EDB45A | same | --lk-cloudberry, the brand dot only |
| Warning | #C98A1E / #E0A64A | #8A5D0C / #E0A64A | --warning. The light swatch is 2.7:1 on the page |
| Stop | #C8483A / #E8705F | #B03A2D / #E8705F | --danger. The light swatch is 4.3:1 on the page |

Not on the sheet, set by hand: --surface-secondary, --surface-tertiary, all -soft fills and their foregrounds, --success, the edge and track colors, --lk-bar and the trace bars. --focus keeps the blue from the first palette, because a green ring would disappear against spruce buttons.

The app sets one more by hand, in app.css, outside the theme file: --danger-soft-hover, the hover fill of a danger-soft button. It is --lk-danger-track in light and #46221E in dark, because the fill HeroUI derives left the button's text at 4.45:1.

## Mockup names to theme names

Some mockups use short local names. Use the theme names in code.

| In the mockups | In the theme file |
|---|---|
| --lk-routed, --lk-routed-soft | --lk-decision-routed, --lk-decision-routed-soft |
| --lk-chosen, --lk-chosen-soft | --lk-decision-chosen, --lk-decision-chosen-soft |
| --lk-default, --lk-default-soft | --lk-decision-default, --lk-decision-default-soft |
| --warning-edge, --warning-track | --lk-warning-edge, --lk-warning-track |
| --danger-edge, --danger-track | --lk-danger-edge, --lk-danger-track |
| --code-bg | --lk-code-background |
| --chart, --grid | --lk-chart, --lk-chart-grid |
| --run, --wait | --lk-trace-run, --lk-trace-wait |

Anything else in the mockups uses the HeroUI name directly.

## Rules

- Focus is blue (--focus), never the accent.
- Cloudberry (--lk-cloudberry) is only the dot in the wordmark, drawn on its own before the name with no tile behind it. It is 2.2:1 on white in light, so it never carries text, a state or meaning.
- Money states: healthy uses success, low uses warning, used up uses danger. Each always comes with an icon and words.
- Admin role chips are neutral and outlined.
- Decorative bars (--lk-bar) and trace timing bars are aria-hidden, so no contrast rule applies to them.
- Fonts: Atkinson Hyperlegible Next for UI, Newsreader (--font-serif) for page titles, sign-in and setup headings, the conversation title and the spend headline amount, Atkinson Hyperlegible Mono for model ids, keys and commands. Atkinson Hyperlegible draws zero with a slash. Numbers that line up in columns use tabular figures (the .lk-num class).
- Type scale from the foundations board. Every screen uses only these sizes (the doc boards' own headings are exempt).

| Style | Font | Size/line | Weight | Used for |
|---|---|---|---|---|
| display | Newsreader | 34/40 | 400 | Spend headline amount |
| title | Newsreader | 30/36 | 400 | Page titles, sign-in and setup headings |
| stat | Sans | 26/32 | 600 | Stat tiles, tabular figures |
| dialog-title | Sans | 20/26 | 600 | Dialog and sheet titles, empty chat greeting |
| body-chat | Sans | 16/26 | 400 | Messages and the message box |
| heading | Sans | 15/22 | 600 | Card and section titles |
| body | Sans | 14/22 | 400 | Default text, tables, buttons (500) |
| small | Sans | 13/20 | 400 | Descriptions (.desc) |
| label | Sans | 13/18 | 500 | Field labels |
| caption | Sans | 12/16 | 500, 400, 600 | Chips and table headers (500), secondary lines such as a table's second line (400), group headings in the menu and the conversation list (600) |
| mono | Mono | 13/20 | 400 | Ids, keys, commands. 12 inside a 12 line; in a field, the field's size |

In code each style is one utility (`text-heading`, `text-body`, ...) that sets the size, the line height and, where it differs from the body's, the weight, so a screen names the style alone (ADR 0112). Caption carries no weight: a chip or a table header names 500.

Phone steps one size up for reading at arm's length: body 15, descriptions and labels 14, card titles 17, stat 22, title 26, top bar title 16. See phone.md. md buttons keep 14 (ADR 0108).

Outside the scale, as drawn (ADR 0112): the wordmark (18, semibold, tight tracking), the conversation title (Newsreader 20, 18 on a phone), inline code in a reply (0.9 of the message), and the setup recovery key (mono 17/28).

Icons are 16, 18 on a phone, and 14 in a chip or an inline row. The 16 and 18 are one token, --lk-icon, the Icon component's default size (ADR 0112); an icon that is smaller on purpose names its own size.

## Spacing

Steps of 2 up to 16, then 20, 24, 28, 32, 40, 48, 64. Nothing else.

- Page padding 32 top, 40 sides, 48 bottom on desktop. 16 on phone.
- Page sections 24 apart. Title to lede 4. A lede is at most 780 wide.
- Card padding 24 (20 sides with 16 top and bottom for stat tiles and the Spend by day card). Sign-in, setup and empty-state cards 32.
- Dialog body fields 16 apart. Table cells 10 by 12. Messages 24 apart.
- Inline icons sit 4 down from the text top, to line up with the first line.

## Shell widths

From 1024px: the side menu 232, the collapsed rail 65 (64 inside its 1px border), chat's conversation column 232 and 288 from 1280, and the chat header 65 tall, so its row lines up with the menu's brand row (ADR 0090, ADR 0107). They are tokens in app.css: --lk-menu-width, --lk-rail-width, --lk-conversations-width, --lk-header-height.

## Radius

| Value | Role |
|---|---|
| 2 | Bars in charts |
| 4 | Checkboxes, skeleton lines |
| 8 | Buttons, fields, segment buttons, the logo tile |
| 10 | Alerts, notes, inner tables, segmented control groups, the workspace switcher, the phone drawer's items |
| 12 | Cards, popovers and menus, the message box, state stages |
| 16 | Dialogs, sheets, message bubbles (the tail corner is 4) |
| full | Chips, tags, switches, meters |

## Borders

- 1px --border for cards, tables, dialogs and outline buttons. 1px --separator for rows and dividers inside them. They are two tokens because HeroUI gives them different roles; keep them apart.
- 1px --field-border for fields, checkboxes and anything a person types into or toggles. This is the one that has to reach 3:1.
- 1px --lk-warning-edge or --lk-danger-edge on warning and error alerts. Neutral info notes have no border.
- 2px --focus outline, 2px offset, on :focus-visible.
- 2px --danger on a field with an error.
- 1px solid --border on a read-only field, which also takes the --surface-secondary fill and muted text (ADR 0108).
- 2px accent underline on the selected tab.
- 1px dashed --border only for optional-step markers.

## Shadows

- --overlay-shadow on menus, popovers, tooltips, dialogs and drawers, and on Scroll to latest in chat, which floats over the conversation as a popover does, with full corners (ADR 0112). Nothing else casts a shadow.
- --surface-shadow exists in the theme but no screen uses it. Cards stay flat: app.css sets it to none, in light and dark, because HeroUI draws it under every card and alert (ADR 0108).
- --backdrop (rgba(33,36,35,.55) in light, rgba(0,0,0,.65) in dark) behind dialogs and the phone drawer.

## Measured contrast

Computed with the WCAG 2.1 formula, light / dark. Values are cut, never rounded up.

Text, needs 4.5:1
Muted text in info note: 5.5 / 6.1
Unit prefix and suffix: 6.2 / 6.8
Table header text: 5.5 / 6.1
Unselected tab: 5.7 / 7.5
Danger text button in dialog: 6.9 / 4.7
Chips, Healthy, Low, Used up, No cap: 6.4, 6.1, 5.9, 5.5 / 6.0, 6.6, 5.0, 6.1
Primary button: 8.7 / 9.7
Menu current item: 7.3 / 6.8
Link in drawer: 7.6 / 7.9

Edges and states, needs 3:1
Field border on field: 3.6 / 3.7
Field border on page: 3.2 / 4.1
Field border on dialog: 3.6 / 3.3
Checkbox fill: 8.7 / 8.8
Focus ring on dialog: 7.0 / 6.9
Selected tab underline: 8.0 / 9.7
Selected pill outline: 5.5 / 6.1

Palette: Spruce and Cloudberry. Grounds, surfaces, lines, fields and text are near-gray: the sheet's lightness with about a third of its chroma, all at the spruce hue. Spruce itself, its soft fill, the state colors and cloudberry keep their color. Light Warning and Stop are too pale for text and edges, so warning text and the low meter use #8A5D0C and danger uses #B03A2D. Light field borders use #838886, because the sheet's Field swatch is 2.9:1 on the page.

## Tokens added after the canvas

`--lk-trace-run` and `--lk-trace-wait` in dark were not drawn on the canvas. Check them on the trace screen in dark and adjust if they look wrong. They are decorative.
