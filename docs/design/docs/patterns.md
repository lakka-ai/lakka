# Patterns

Build each pattern once as a shared component and reuse it everywhere. The drawn versions are in `mockups/static/Patterns.html` (light) and `mockups/static/Patterns-Dark.html` (dark). Each pattern lists the HeroUI v3 components it is made from. Keyboard and screen-reader rules for each are in `docs/accessibility.md` under "Shared patterns".

Measurements below come from the mockups at desktop size. Phone changes are in `docs/phone.md`.

## 1. Why this model

HeroUI: Chip styling on a Button, Popover. Shown on every reply, next to the model name.

- Chip variants and tokens: routed (`--lk-decision-routed`), you chose (`--lk-decision-chosen`), default (`--lk-decision-default`), pinned, cheaper model (`--lk-decision-fallback`), refused (`--lk-decision-refused`). Each has a `-soft` background.
- The popover shows the reason sentence, then Model, Route, Cost, and a View trace link.
- The chip text stays under 16 characters in English so it survives translation. The button's accessible name starts with the chip text, then gives the full reason sentence (ADR 0129).

## 2. Budget meter

HeroUI: Meter, Popover, Button. Shows the smallest headroom among the caps that apply. Hidden when no cap applies.

- The meter shows what is LEFT, not what is used.
- States: healthy, low, used up. Low starts at 20 percent left, or at the first alert threshold if an admin set one higher.
- Low and used-up change the words, the width and the colors (`--lk-warning-edge`, `--lk-warning-track`, `--lk-danger-edge`, `--lk-danger-track`), never the color alone.
- The popover lists every cap that applies, with "The smallest is shown" as a subtitle under its title.

## 3. Fallback notice

HeroUI: Alert (warning, soft) inside the reply, with a 1px `--lk-warning-edge` border, role status. Appears before the first token and stays with that reply.

## 4. Error alert and notice

HeroUI: Alert.

- Errors: danger soft fill, `--lk-danger-edge` border, role alert. Warnings follow the same rule with the warning soft fill and `--lk-warning-edge`. Any alert that reports a problem has a border in its own tone. One plain sentence on what happened, one on what to do. Never a status code.
- Neutral info notes: `--surface-secondary` fill, no border on purpose (they explain, they do not warn), 10px corners, an info icon in `--muted`, 14px text, padding 10px 14px, icon aligned to the first line. Use role status in chat (announced) and role note on a page (read in order, not announced).

## 5. One-time secret dialog

HeroUI: AlertDialog, Alert, InputGroup with a copy Button.

- No close button, no Esc, no backdrop close. "I have saved it" is the only way out.
- Header, body and footer follow Pattern 13, without the close button. The header keeps the same height so dividers line up with other dialogs.
- Used for the recovery key, API keys, invite links and webhook signing secrets.

## 6. Write-only credential field

HeroUI: TextField (type password), Description, Chip.

- The stored value never comes back to the browser. The field is empty. A "Key set" chip and the description say a value exists.
- Save and Remove belong to the dialog or settings form around the field, not to the field.

## 7. Table with decorative bars

HeroUI: Table.

- Text 14px. Header row: `--surface-secondary` background, 12px muted text, padding 8px 12px.
- First and last cell padding 20px. Row cells 10px 12px.
- Amounts and counts are real text, right aligned, tabular figures.
- The bar column is aria-hidden and has no header text. Bars appear only where rows are a share of a total.
- A table that fills its card runs edge to edge. A table next to other content in a card uses Pattern 14.
- With no rows, the table gives way to the empty list line (Pattern 14, ADR 0112).

## 8. Trace timeline step

HeroUI: Disclosure per step, inside an ordered list. Plain step names. Durations right aligned. Timing bars (`--lk-trace-run`, `--lk-trace-wait`) are aria-hidden.

- A step with nothing to show (no details, notes or attempts) is not a disclosure. It is a plain row with a muted `-` where the chevron would be, and clicking it does nothing.

## 9. Tool approval card

HeroUI: Card, Button group. Arguments are plain text in a code block (Controls: long lines scroll sideways), never rendered as markup or links. Allow once comes first, then Always allow, then Deny. An approval that belongs to an API key shows as a dashed card that says where it can be answered.

## 10. Destructive confirmation

HeroUI: AlertDialog, TextField, Button (danger).

- Typed confirmation only where the action cannot be undone. The danger button uses aria-disabled until the typed text matches.
- Reversible removals (Revoke, Withdraw, Remove cap) use a plain two-button confirm.

## 11. Field with a unit

HeroUI: InputGroup with a text prefix or suffix.

- The unit is plain muted text inside the field. No fill and no divider, so the group reads as one input.
- 12px from the field edge to the unit, 6px between the unit and the value.
- The focus ring goes round the whole group.
- A currency sign is aria-hidden and the currency is in the label, for example "Input price per million tokens, in US dollars" with ", in US dollars" visually hidden.
- A suffix such as days or tokens is linked with aria-describedby.
- Short numbers, such as days, are right aligned next to their suffix.

## 12. Settings section

HeroUI: Card, Checkbox, Select, InputGroup, Button.

- One option per row. Label and description on the left, the control on the right, a divider between rows, Save under the last divider on the right.
- Title first, then the rows. Row padding 16px top and bottom.
- On/off options are checkboxes on the right of the row, because nothing applies until Save.
- A Switch is only for a change that applies at once, such as Enabled and Asks first in a tool list.
- A read-only value, such as "Set per workspace", sits where the control would be.
- Every settings card has a Save button.
- A radio's description sits under its label, at field help's size. What a chosen radio asks for, such as a server's address, sits right under it, indented to its label, inside the radio group; the arrow keys stay in those fields (ADR 0112). In code: RadioOption, with RadioDetails for the fields, beside CheckboxOption.

## 13. Form dialog

HeroUI: Modal.

- Every add, edit and replace action opens a dialog. The page underneath stays a list. No inline add or replace forms.
- One width for every dialog: 720px, or the viewport less 32px (ADR 0108). Below 640px it is a bottom sheet.
- Anatomy: header with the title (20px, 600) and a 32px close button, a divider, the body, a divider, the footer.
- Padding: header 20px 24px 16px with a minimum height of 69px, body 20px 24px with 16px between fields, footer 16px 24px 20px.
- Footer buttons sit on the right with the primary last. A destructive action (Remove cap, Delete route, Remove provider) sits bottom left as a danger text button.
- The same footer rule applies to full-page forms, such as the sign-in provider form.
- A dialog that lists things to act on rather than a form, such as the messages routed to a route, keeps the same anatomy with one Done button in the footer (ViewDialog).
- Focus starts on the first field, or, for a dialog opened to finish one thing such as an example added from a message, on that field with the caret at the end (FormDialog's initialFocus). A ViewDialog starts on the dialog itself, so its title is heard first.
- When saving fails, the error alert (Pattern 4) sits at the top of the body. It can carry the action that fixes the problem, such as Allow {origin} when a tool server's origin is not on the allowed list, as a button in the alert's tone (FormDialog's error actions, ADR 0117).

## 14. Card header, inner table and paging

HeroUI: Card, Table, Button.

- A card's note goes under its title as a subtitle, never beside it on the right.
- A chip that says the card's state, such as In use or Exporting, sits right after the title (CardSection's badge).
- In a card whose table runs edge to edge, anything else above the table, such as an error notice, is 20px in, level with the table's first column (CardInset).
- An empty list is one muted line (small, muted, at most 780px wide): inside its card under the header, or in a card of its own where the list has no card. Nothing yet and nothing matching a filter read the same (EmptyList, ADR 0112). A page with nothing yet uses the empty state card instead (EmptyState); it is not a list.
- A table next to other content in a card gets a 1px `--border` border, 10px corners and a `--surface` background, with the Pattern 7 header.
- Paging sits under the card, outside it. The count on the left ("Showing 1 to 7 of 31"), Previous and Next on the right. Previous uses aria-disabled on the first page.
- Lists sorted by time say Newer and Older instead.
- A short preview, such as the members on Workspace settings, ends with a "Show all" link and has no pager.

## 15. Tabs and pills

HeroUI: Tabs, in two styles.

- Underline tabs switch between sections of a page (Report, Budgets and alerts).
- Pills switch the view inside one card (By person, By model), and toggle views such as Chart and Table or the date range.
- Both are a tablist: arrow keys move between tabs, and the panel is labelled by the selected tab. Toggles that are not tabs use aria-pressed.
- The selected pill has an inset 1px `--muted` outline and bold text. See the rule at the end of the theme file.

## Shell parts that are not numbered

- Side menu: Chat alone in its own group with a 28px filled accent icon tile and bold label, then a divider, then the other items with 16px stroke icons in `--muted`. The current item uses `--accent-soft` with `--accent-soft-foreground`, and its icon takes the text color.
- Account row: the last item in the menu on every page. It opens the account menu: the source link with the AGPL sentence, then Sign out (ADR 0107). A button with a 28px round avatar, the name (14px, 500) and the email (12px, muted) under it, 48px tall. In the rail it is the avatar alone, with the name and email in its tooltip. On phone it sits in the drawer footer at phone sizes (30px avatar, 15px name, 14px email). Round avatars are people; workspaces are rounded squares.
- Conversation list: the Conversations heading sits in a 32px row level with the logo row, and New conversation is a full-width primary button 16px below it, so its top lines up with the workspace switcher and the bottom edge of the chat header.
- Message box: one line tall when empty (rows 1). It grows with the text.
- Collapsed menu: a 64px rail with the expand button at the top (no logo), the workspace tile, then 40px icon-only items with tooltips, and the Admin heading centered above the admin items. The current item keeps --accent-soft. Every element keeps the vertical position and height it has in the full menu (brand row 32, workspace switcher 48, Chat 40, items 34 with 2px gaps, account 48), so expanding and collapsing only changes width.
- Admin role chips are neutral and outlined, never warning colored.

## Controls, one size each

Every board shares these definitions. Do not make local variants.

- Button: two sizes, 8px corners, 500 (ADR 0108). lg, a field's height (40px, 44px on a phone; ADR 0111), for the main action of a page, card, list or empty state, for a button beside a field, and for every button on the sign-in, setup, invite and reset pages; md, 32px with 14px text at every width, phone included, for every other button. Icon-only buttons are square. Primary, outline, ghost and danger differ only in color; the outline border is `--border`.
- Field, select, input group: 40px tall, 8px corners, 1px `--field-border`. Select text is left aligned.
- Chip (status, read only): 24px tall, 12px 500, 0 8px padding, 6px gap to its icon, full corners. A chip that opens something is a button with the same look. A chip can also follow a name in a table cell, such as Price updated (accent) after a catalogue model, with a visually hidden sentence after it that says what it means (ADR 0116). One component draws them all: StatusChip.
- Tag (removable value): 28px tall, 13px, full corners, with a 24 by 24 remove button named "Remove" and the value. Allowed email domains and alert thresholds are tags inside a field (TagsField, ADR 0109): 22px with a 20px remove button, 26 and 24 on a phone, so the field stays a field's height until its tags wrap.
- Checkbox: 18px, 22px on a phone, 4px corners. Ticked, it is one solid accent square.
- Switch: a track as tall as a checkbox, 18 by 32 (22 by 38 on a phone), with a round knob 2px inside its edge (12px, 16px on a phone). The knob uses `--accent-foreground` when on.
- Segmented control: 2px padding, 10px corners, 32px buttons with 8px corners.
- Meter track: 6px tall, full corners.
- Code block: mono 13/20, padding 10px 12px, 8px corners. Long lines scroll sideways, so code keeps its indentation (ADR 0108), and the block takes keyboard focus. Tool arguments, a tool's result and what a trace recorded are code blocks too (ADR 0112). One component draws them all: CodeBlock.
- Icon: 16px, 18px on a phone (--lk-icon, ADR 0112). 14px in a chip or an inline row, as drawn.
- Links that stand alone (View trace, Show all) get 4px block padding so the hit area is at least 24px without moving the text.

## States

The same rules on every board:

- Hover: buttons and nav items take `--surface-tertiary`. Primary and danger buttons drop to 90 percent opacity. Links thicken the underline to 2px.
- Active (pressed): 80 percent opacity.
- Focus: 2px `--focus` outline with a 2px offset, on :focus-visible only. In a list whose rows are 2px apart or touch (the side menu, the conversation list, a picker's options), the ring is drawn 2px inside the row, so it does not cover its neighbours. A control shows one ring: a box that holds a field, such as the message box, rings while the field has focus, not while a button in it does.
- Disabled: 50 percent opacity and a not-allowed cursor. Use aria-disabled where the control has to stay focusable to explain itself. Text that says why a control is disabled, such as an option's description, is not dimmed (ADR 0112).
- Read-only: a field that shows a value it cannot change keeps it readable, with the `--surface-secondary` fill, muted text and a solid `--border` edge (ADR 0108).
- Form errors: the field border turns 2px `--danger`, a 13px `--danger` message sits under the field and says how to fix it, and the input has aria-invalid and aria-describedby pointing at the message. Drawn on the Foundations board.
- Empty, loading and error states are drawn on the Chat, Routing and Spend states boards. Loading uses skeleton lines (4px corners), not spinners. Other pages use the same parts: the empty list line, the empty state card and the error alert.

## Building on HeroUI

How the app turns these patterns into code (ADR 0112). The aim is one way to do each thing.

- HeroUI's component CSS sits in `@layer components`. app.css overrides HeroUI classes in the same layer, after HeroUI's rules, so they win by order, and a utility class on one element still wins over both. A `!` is never needed against HeroUI.
- A rule sits outside the layers only where a HeroUI selector is more specific than the override can be: a ticked checkbox, the switch, an invalid field's edge, the option card radio, the focus rings on fields and controls, and read-only fields. Those rules also beat any utility on the same element.
- Where HeroUI reads a variable when the page runs, set the variable instead of overriding each selector: `--container-lg` is the dialog width, `--radius-3xl` the corners of cards and popovers, `--surface-shadow` none keeps cards flat.
- A HeroUI variant comes before an override. The design's secondary button is HeroUI's `tertiary` variant. Sizes are HeroUI's size variants, each set from tokens, and an element asks for the size it needs (ADR 0108). The sizes no screen uses yet (button sm, toggle sm and lg, the 28px md tag) stay defined as the scale.
- What would otherwise be written out as utilities is a shared class: `lk-card` (the card look), `lk-focus` and `lk-focus-inset` (the focus ring, 2px out or 2px inside), `lk-popover-fit` (a popover keeps the phone's 16px gutters), `lk-skip-link`, `lk-pill-panel`. Screens use these and the pattern components, and do not restate the look.
- Lengths in TSX are Tailwind scale steps (`max-w-195`, `w-88`). Arbitrary values are only for what is not a length on the scale, such as grid templates. Colors come from tokens, never hex (the one exception is an SVG mask's black and white); inline styles only carry data widths, such as bars and meters.
