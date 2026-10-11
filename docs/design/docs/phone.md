# Phone layout

Every screen must work at 390px wide. Five screens are drawn at phone size, in light and dark, as the reference for the rest:

- `mockups/static/Phone-Spend.html`: tables, pills, summary tiles
- `mockups/static/Phone-Routing.html`: settings rows
- `mockups/static/Phone-People.html`: search, info note, table with row actions, paging
- `mockups/static/Phone-Sheet.html`: a form dialog as a bottom sheet
- `mockups/static/Phone-Menu.html`: the admin menu drawer
- Chat on phone: `mockups/static/Chat-Phone.html` and its variants

Apply these rules to every screen that is not drawn at phone size.

## Rules

One column with 16px side gutters. The page itself never scrolls sideways.

Top bar: menu, page name, workspace. The side menu becomes a drawer over the page. Chat stays first and set apart, and the admin pages sit under an Admin heading.

Wide tables stay real tables. They scroll sideways inside their card with the first column pinned. The scroll area is a focusable region named after the table, ending in "Scrolls sideways", so keyboard users can reach it.

Row actions that do not fit become one actions button per row, named "Actions for" and the person.

Pills scroll sideways in their own row. Underline tabs keep their full-width line, with the tabs on the left, each as wide as its label, as on desktop.

Settings rows: checkboxes stay on the right. Selects and fields move under their label at full width. Save stays under the last divider.

Dialogs open as bottom sheets with the same header, body and footer as on desktop, close button included. One-time secret sheets still have no close button.

Touch targets are at least 44px, except md buttons, which keep their desktop 32px and 14px text (ADR 0108). lg buttons are a field's height, 44px (ADR 0111). Fields are 44px, checkboxes 22. Type steps up one size: body 15, descriptions and labels 14, card titles 17, stat numbers 22, page titles 26, top bar title 16, dialog and sheet titles 20. Chips are 28 tall with 13px text (ADR 0108). Icons 18.

Paging: the count on the left, Previous and Next on the right.

Keyboard and screen reader on phone: the drawer and sheets are modal. Focus moves in, stays inside, and goes back to the button that opened them. Esc and Close dismiss them. Menu has aria-expanded. The backdrop is aria-hidden and has no tab stop.

## Breakpoint

The mockups show 390px and 1440px. The phone layout is used below 1024px, and the side menu from 1024px, where its 232px leave room for the tables (ADR 0090). Widths in between, such as a tablet, are not drawn and get the phone layout. Dialogs are bottom sheets below 640px (ADR 0091).
