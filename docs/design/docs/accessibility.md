# Accessibility notes, per screen

Copied from the notes on the design canvas. These are requirements, not suggestions. Target: WCAG 2.1 AA.

Global rules that apply everywhere:

- Real elements only: button, a with href, input with a label. Never a click handler on a div or span.
- Icon-only buttons have an aria-label. Decorative icons are aria-hidden.
- Focus ring: 2px solid var(--focus), 2px offset, on every interactive element. The ring is blue on purpose so it never blends into a spruce button.
- Disabled actions that need explaining use aria-disabled plus aria-describedby, so they stay focusable and say why.
- State is never carried by color alone: every state color comes with an icon and words.
- Text contrast 4.5:1, edges and states 3:1. See docs/tokens.md for the measured pairs.
- Touch targets at least 44px on phone, except md buttons (ADR 0108).

## Shared patterns

Why this model: the chip is a button that opens a popover. Its accessible name starts with the chip text, then gives the full sentence: 'Cheaper model. Why this model: Your budget would not cover Claude Sonnet 4.5, so a cheaper one answered.' (ADR 0129).

Budget meter: a meter with aria-valuetext such as '$31.20 left of $50.00, your monthly cap, resets Oct 1'. The low and used-up states change the words, not only the color.

Fallback notice and other notices: role status in chat, announced once. The same grey info note on a page is role note, read in page order and not announced. Errors: role alert.

One-time secret dialog: alertdialog. Focus starts on Copy. Esc and clicking outside do not close it. Only 'I have saved it' closes it, then focus returns to the button that made the secret.

Write-only field: the stored value is never sent to the browser. The field is empty and its description says a key is set.

Destructive confirmation: Delete permanently uses aria-disabled until the typed email matches, so it stays focusable and can say why.

Tables with bars: the bar cell is aria-hidden. Amount and count are real text in their own cells.

Trace steps: each step with details is a disclosure button with aria-expanded. Its name includes the step name, the outcome and the duration. A step with nothing to show is a plain heading with the same name, not a button.

Tool approval card: focus moves to its heading when it appears. Allow once comes first. Esc does not answer it.

Field with a unit: the unit is plain text inside the field. A currency sign is aria-hidden and the currency is in the label, for example 'Input price per million tokens, in US dollars'. A suffix like days or tokens is linked with aria-describedby, so it is read after the value.

Settings section: each option is a real label tied to its control, and its description is tied with aria-describedby. Checkboxes, not switches, because nothing applies until Save. When Save finishes, a status message says the settings were saved.

Form dialog: role dialog with aria-labelledby on the title. Focus starts on the first field, Esc and Close cancel, and focus goes back to the button that opened it. The destructive action in the footer opens its own confirmation. A dialog opened to finish one thing starts on that field instead (initialFocus). When saving fails, the error alert at the top of the body is role alert, and an action it carries, such as Allow {origin}, is a real button that names what it does. A dialog that lists things to act on (ViewDialog) starts focus on the dialog, so its title is read first, and Done closes it.

Inner tables and paging: the table is labelled by its card title. Paging is a nav named Pages. On the first page Previous or Newer uses aria-disabled, so it stays focusable.

Tabs and pills: both are a tablist with arrow-key movement, and the panel is labelled by the selected tab. The selected pill has a 1px outline in --muted and bold text, so the state never rests on a fill change alone.

## Chat, desktop

Tab order: Skip to message box, workspace switcher, main nav, New conversation, conversation list, conversation title and Rename, model picker, budget, messages, message box, Attach files, Send.

Conversation list: one tab stop. Arrow keys move, Enter opens, the Options button on each row opens Rename and Delete.

Landmarks: nav 'Main', nav 'Conversations', main 'Chat'.

Each message is an article. Replies are labelled 'Reply from Claude Sonnet 4.5'.

The conversation title is the h1. Headings under it start at h2: a reply's Markdown headings, tool calls and approval cards. A table in a reply is a focusable region named 'Table 1, scrolls sideways', numbered within the reply so two never share a name (ADR 0112).

New conversation is a link drawn as a button, since it goes to an address (ADR 0112).

Streaming text is outside any live region. One polite status line says 'Reply finished' or 'Reply stopped'.

The fallback notice is a status message, announced when it appears, before text arrives.

The capture notice is plain text under the header, read in page order. Not live.

Enter sends. Shift and Enter together add a new line.

Collapsing: the menu and the conversation list each have a collapse button at the top right of their column, with aria-expanded and aria-controls. The menu collapses to a 64px rail of icons: every item keeps its name as aria-label and shows it as a tooltip on hover and focus, and the current item stays marked. The conversation list hides completely, and Show conversations and New conversation appear left of the title. When a toggle is used, focus stays on the button that replaces it. Both choices are remembered per browser and apply on every page.

## Chat, phone

Nav and conversations move into a drawer opened by Menu. Menu has aria-expanded. Focus stays inside the drawer until it closes. Esc closes it and focus returns to Menu.

The model picker opens as a full-width sheet.

Budget stays visible as a one-line chip under the top bar whenever a cap applies.

All targets are 44px or larger. The message box grows to six lines, then scrolls.

## Chat states

Errors use role alert and sit directly above the message box, so the refused text below is the next thing read.

Stopped and broken replies keep their text and add one sentence inside the same article.

Attachment errors are listed per file and tied to Attach files with aria-describedby.

When Send cannot be used, it has aria-disabled and a description that says why. It stays focusable.

Loading: skeletons are aria-hidden. The main region has aria-busy while the conversation loads.

## First-run setup

One form per step, inside main. Progress is an ordered list with aria-current='step' on the current step.

After Continue, focus moves to the new step's heading.

Setup code: autocomplete off, spellcheck off. A wrong code shows an inline error tied to the field and keeps what was typed.

Recovery key: in a read-only text area so it can be selected, with Copy and Download buttons. Copy announces 'Copied' as a status.

Continue on step 2 uses aria-disabled until the checkbox is ticked.

Password: a button that says Show while the password is hidden and Hide while it is shown. Its name changes, so it has no aria-pressed (ADR 0098).

## Sign in and invites

The SSO button comes first, because most people at a company use it. Its label includes the provider's name.

A wrong email or password is one alert above the form. It never says which of the two was wrong. Email keeps its value and focus moves to Password.

Invite: the workspace and the role are in the heading and the first sentence, so a screen reader hears them before any field.

The invalid-link and already-member pages have one action each. The heading takes focus on load.

## Spend and budgets

Report and Budgets and alerts are a tablist. Arrow keys move between tabs.

The date range is a group of toggle buttons with aria-pressed. The chosen dates are also written as text under the tabs.

The spend chart is optional. It is one image whose name is a text summary. Chart and Table is a toggle, and the table lists every day with amount and request count.

Where the money went: the pills are a tablist and the table is its tab panel. Every breakdown is a real table. Bars are aria-hidden.

Meters use aria-valuetext with what is left, the cap and the reset date.

Edit cap buttons carry the person or key name, for example 'Edit cap for Lina Berg'.

Set a cap: focus starts on Amount, a field with a $ prefix. The currency is in the label. Esc and Close cancel. Reset period is a radio group. Alert at is a list with a search field: each picked percentage is a tag in the field with a remove button named for it ('Remove 75%'), and Delete removes a focused tag. A percentage not offered is typed into the search. Esc first clears the search, then closes the list (ADR 0109). Remove cap sits bottom left and opens a plain confirm.

Members never receive other people's numbers from the server. The page is not just hiding them.

## Routing

Choose models automatically is a checkbox, because nothing applies until Save. Its description is tied with aria-describedby. Default model and Pinned model read their descriptions too. Save sits under the last row. The routing-off state uses the same rows.

Edit buttons in the routes table are named 'Edit route Code' and so on.

Edit route: focus starts on Name. Description is a labelled text area, and its help text is tied with aria-describedby (ADR 0122). Fallback order uses Move up and Move down buttons, so it never depends on dragging. After a move, focus stays on the moved item and a status message says its new position.

The example line count is a polite status. It updates at most once a second while typing.

Signals owned by another route are disabled, and the owning route is part of the label.

Try a phrase: the result is a status region, announced after Try.

When people choose another model: Review buttons are named 'Review messages routed to Summary' and so on. In the list, each message's text describes its Add to a route and Dismiss buttons (aria-describedby), so they say which message they act on. Show more is a button with aria-expanded and aria-controls. Each chosen model is a section labelled by its heading. A dismissal is said in a polite status line, and focus moves to the next message's Add to a route, or to Done when none is left. Opened from a message, Edit route starts in the examples, with the caret after the message, and the note above them describes the field.

## Requests and traces

Filters sit in a search landmark. Changing a filter updates the table and a status line says how many requests match.

View trace links are named with the person and the time.

Paging uses Newer and Older. On the first page Newer uses aria-disabled.

Trace steps are an ordered list. Each step header is a disclosure button named with the step, outcome and time, for example 'Holding the budget, moved to a cheaper model, 6 milliseconds'. A step with nothing to show is a heading with the same name and no button.

Timing bars are aria-hidden. Times are text.

The summary is an aside that comes after the steps in reading order, even though it sits on the right.

## Workspace settings, tools and connections

Every row action names its target, starting with the words on the button, for example 'Make admin: Erik Holm' or 'Revoke key CI bot' (ADR 0129).

Remove member and Revoke key use a plain two-button confirm. Deleting a person, on People, uses the typed confirmation.

Create invite link and Create key open the one-time secret dialog.

Enabled and Asks first are switches with the tool name in their labels. When a tool is disabled, its Asks first switch uses aria-disabled.

Add a tool server: the options are a radio group. Fields for the chosen option come right after it in reading order, not inside its label, and the arrow keys stay in them (ADR 0112). An option that cannot be chosen says why in its description, which is not dimmed. Add uses aria-disabled until the shared-account box is ticked.

Content capture: 'Record prompts and replies' is a checkbox and 'Keep recorded text for' is a field with a days suffix, both applied by Save. With recording off, the days field is read-only, keeps its value and says to turn recording on to change it (ADR 0096). Members see the same two rows as read-only text.

The member notice at the top is a note, read in page order.

Members get the same Workspace settings page without the admin sections. Nothing admin-only is sent to their browser.

## Instance admin

The page name is the h1. The Admin group in the menu, marked with aria-current, tells people where they are.

Workspaces: the first item in the Admin group. The table has the workspace name as a link to its Workspace settings, then admins, people, spent this month and created date. Rename and Delete name the workspace. Create workspace and Rename open form dialogs with focus on Name. Delete opens an alertdialog: focus starts on the confirm field, and Delete workspace uses aria-disabled until the typed name matches. After a delete, focus goes to the table and a status says the workspace was deleted (ADR 0104).

People and sign-in has two tabs, People first and Sign-in providers second. Models and providers has Models first and Model providers second. The tabs are a tablist named after the page, with arrow keys moving between them. The selected tab is part of the address, so a link can open either tab, and the menu item stays current on both.

People: Find a person filters as you type, and a status line says how many match. The info note under the search is a note, read before the table. Suspend, Export data and Delete name the person. Paging is a nav named Pages, with Previous on aria-disabled on the first page.

Sign-in providers tab: the client secret is write-only. The redirect URI is read-only, with a Copy button that announces 'Copied'. Allowed email domains is the same tags field as Alert at, with nothing suggested; empty, it says 'Any domain' (ADR 0109). 'Let this provider create new accounts' is a checkbox, applied by Save provider. Remove provider sits bottom left and opens a plain confirm, or a typed one when people would be left with no way to sign in (ADR 0097).

Model providers tab: the check result is text, with its icon aria-hidden. Check updates the result in place and announces it as a status. Replace key opens a dialog with focus on the new key field.

Models tab: Add a model opens a dialog with focus on Model name. Prices have a $ prefix with the currency in the label. Context window and output limit have a tokens suffix linked with aria-describedby. The form is checked on submit, and focus moves to the first field with a problem.

Price updates: Get price updates is a switch, because it applies at once. Its name is the row label, and the description naming the host is tied with aria-describedby. When it cannot be turned on, it stays focusable with aria-disabled and its reason is read with it, as well as shown. Turning it on or off, and Check now, announce the result as a status. The Price updated chip on a catalogue row is followed by a visually hidden sentence saying the price came from an update.

Tool servers: Allow an origin opens a form dialog with focus on Origin. An origin that is not one keeps the dialog open, shows the error under the field, tied to it, and puts focus back in the field. The table is labelled by its card title, Allowed origins, and each Remove is named 'Remove https://mcp.example.com'. Remove opens a plain confirm. After allowing or removing, a status line says what changed, and after a removal focus goes to the table. Origins set by the operator are a plain list, with nothing to act on.

Retention: each row is a labelled field with a days suffix and a description. Save is under the last row. Run now announces the new counts as a status when it finishes.

Diagnostics: the note about removed credentials is read before the download button.

## Collapsed menu

Every desktop page has the collapse button at the top right of the menu. Collapsed, the menu is a 64px rail: Expand menu at the top, the workspace tile, then each item as a 40px icon with its name as aria-label and tooltip. The Admin heading stays, centered and short enough to fit. The current item keeps its soft fill and aria-current.

Every item sits at exactly the same height as in the full menu, so nothing moves vertically when the menu expands or collapses. Only the width and the labels change.

The choice is remembered per browser and applies on every page, so these boards show the same rail everywhere. Content gets the extra 167px (the rail is 65px with its border, ADR 0107). Tables and cards are fluid, so nothing else changes.

On Chat, the conversation list collapses on its own, with Show conversations and New conversation in the chat header.

These six boards are a sample, in light and dark. Every other desktop board takes the same rail with the nav prop set to rail.

## Phone rules

One column with 16px side gutters. The page itself never scrolls sideways.

Top bar: menu, page name, workspace. The side menu becomes a drawer over the page. Chat stays first and set apart, and the admin pages sit under an Admin heading.

Wide tables stay real tables. They scroll sideways inside their card with the first column pinned. The scroll area is a focusable region named after the table, ending in "Scrolls sideways", so keyboard users can reach it.

Row actions that do not fit become one actions button per row, named "Actions for" and the person.

Pills scroll sideways in their own row. Underline tabs keep their full-width line, with the tabs on the left, each as wide as its label, as on desktop.

Settings rows: checkboxes stay on the right. Selects and fields move under their label at full width. Save stays under the last divider.

Dialogs open as bottom sheets with the same header, body and footer as on desktop, close button included. One-time secret sheets still have no close button.

Touch targets are at least 44px, except md buttons (ADR 0108). Body text is 15px.

Paging: the count on the left, Previous and Next on the right.

Keyboard and screen reader on phone: the drawer and sheets are modal. Focus moves in, stays inside, and goes back to the button that opened them. Esc and Close dismiss them. Menu has aria-expanded. The backdrop is aria-hidden and has no tab stop.

## Dark mode contrast

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
