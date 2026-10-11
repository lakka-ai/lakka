# Screens

Every drawn screen, with its route in the app, the roles that see it, the states drawn, and the mockup files. The boards drew shorter paths; the app keeps the workspace in the address (ADR 0090). Routes with no board are listed at the end.

Board names below are files in `mockups/static/`.

## App shell (every signed-in page)

- Desktop: side menu. Brand, then the workspace switcher (name and your role), then Chat alone in its own group with a filled accent icon tile, a divider, then Spend and budgets, Requests, Routing, Tools, Your connections, Workspace settings. Instance admins also get an "Admin" heading with Workspaces, People and sign-in, Models and providers, Tool servers (not drawn; ADR 0117), Instance spend, Retention, Diagnostics. The current item has aria-current="page". At the bottom: the account, whose menu holds the source link and Sign out (ADR 0107).
- Collapsing: a button at the top right of the menu collapses it to a 64px icon rail. Items keep their names as tooltips and aria-labels. On Chat, a button at the top right of the conversation list hides it, and Show conversations and New conversation appear left of the conversation title. Both choices are remembered per browser and apply on every page.
- Members do not see Routing, Tools or the Admin group in the menu. Workspace admins see Routing and Tools; only instance admins see the Admin group. Check each mockup's menu: `Chat-Desktop.html` is the member menu, `Spend-Admin.html` is the admin menu.
- Phone: see `docs/phone.md`. Mockups: `Phone-Menu.html` (admin), `Chat-Phone-Nav.html` (member).

## Collapsed menu

- Applies to every desktop page. On Chat, collapsing also hides the conversation list.
- Mockups on the Collapsed menu page: `Chat-Desktop-Collapsed-Dark.html`, `Requests-Collapsed.html`, `Admin-Workspaces-Collapsed.html`, `Spend-Admin-Collapsed.html`, `Routing-Collapsed-Dark.html`, `Workspace-Collapsed.html`. Other pages are not drawn collapsed: use the same rail.
- The page content takes the extra width. Cards and tables are fluid, so nothing else changes.

## Chat

- Route: `/workspaces/:workspaceId/chat`, with the open conversation as `?c=<conversationId>`. `/` opens chat in the workspace used last (ADR 0090).
- Roles: everyone
- Mockups: `Chat-Desktop.html` (light), `Chat-Desktop-Dark.html`, `Chat-Desktop-Collapsed.html` (menu and conversations collapsed), `Chat-Phone.html` (budget low), `Chat-Phone-Nav.html`, `Chat-Phone-Exhausted.html`, `Chat-States.html`
- Parts: conversation list grouped by date, title with Rename, model picker (Auto by default), budget chip (Pattern 2), messages with "Why this model" chips (Pattern 1), fallback notice (Pattern 3), tool calls and the tool approval card (Pattern 9), message box with Attach files and Send.
- States on `Chat-States.html`: new conversation, loading, writing a reply (Send becomes Stop), stopped reply, reply broke off, refused because the message costs too much, provider unavailable, rate limited (by a provider, or by the per-person limit on model requests, BG-12, ADR 0113, with the same words and the wait), model cannot read this file, attachment errors, budgets cannot be checked, routing off, model picker open, tool calls after a reply, approval from an API key, tool denied.
- Budget used up on phone: `Chat-Phone-Exhausted.html`.
- Replies as Markdown (added after the boards, at the project owner's request, ADR 0105): emphasis, inline code, code blocks as drawn, lists, task lists, quotes, headings from level 2 under the conversation title (ADR 0112), links that open in a new tab, and tables that scroll sideways in their own region. Images show as a link, never loaded. Raw HTML is dropped. Your own messages stay plain text.
- Dropping and pasting files (added after the boards, at the project owner's request, ADR 0106): files dropped anywhere on the conversation are attached; while they are dragged over it, the message box turns accent with a dashed border, and Attach files becomes "Drop files to attach them" with a downward arrow. Pasted files and screenshots are attached. A paste over 2,000 characters becomes a text document, "Pasted text.txt". Text files of any kind can be attached for every model, so Attach files is always offered.
- Following the end (ADR 0105): at the end, the thread follows a reply as it is written; scrolled up, it stays put. "Scroll to latest", a small rounded button centred just above the message box, shows while away from the end; it goes back to the end, follows again, and moves focus to the message box.
- Model picker search (added after the boards, at the project owner's request): the open picker starts with a search field, "Find a model or route", focused. It matches a route by its name or the model it sends to, and a model by its name or id. Auto stays at the top whatever is typed; the Routes and Models sections, and the note under the list, stay as drawn. When nothing else matches, a status line under the list says so. Each model shows its id under its name, in mono and cut with an ellipsis, as in the settings model select; what it reads is shown as small icons (images, PDFs, or lines for text only), with the words for screen readers and on hover. The settings model select is wider than other settings controls, 18rem.

## Spend and budgets

- Routes: `/workspaces/:workspaceId/spend` (Report tab), `/workspaces/:workspaceId/spend/budgets` (Budgets and alerts tab, admins only)
- Roles: admins see the workspace report and budgets. Members see "Your spend" only.
- Mockups:
  - `Spend-Admin.html` (report, admin, interactive tabs), `Spend-Admin-Dark.html`
  - `Spend-Budgets.html` (workspace cap, member caps, API key caps, alerts and the alerts-sent log)
  - `Spend-Member.html` (member view: caps that apply to you, where your money went)
  - `Spend-States.html` (set a cap dialog, new signing secret, no spend yet, budgets cannot be checked, loading skeleton, remove a cap confirm)
  - Phone: `Phone-Spend.html`, `Phone-Sheet.html` (set a cap as a bottom sheet), and their `-Dark` twins.
- Parts: date range pills, summary tiles, optional spend-by-day chart with a Table toggle, "Where the money went" card with pill tabs By person, By model, By surface, By route (Patterns 7 and 15), downgrades and refusals, speed and size by model.
- Money rule: meters show what is left. "Low" starts at 20 percent left, or at the first alert threshold if an admin set one higher.

## Routing

- Route: `/workspaces/:workspaceId/routing`
- Roles: admins edit. Members see a read-only explanation (`Routing-States.html`, "Member opens Routing").
- Mockups: `Routing.html`, `Routing-Dark.html`, `Routing-Edit.html` (edit route dialog), `Routing-States.html` (routing off, no routes yet, member view, try a phrase with no confident route), `Phone-Routing.html` and its dark twin.
- Parts: Settings card (Pattern 12: Choose models automatically, Default model, Pinned model, Save), Routes table with Add a route, Try a phrase (input row, result row), When people choose another model.
- When people choose another model (not drawn; ADR 0114): while the workspace records content, the table ends with a Messages column, a Review button per route with messages, "None" otherwise. Review opens "Messages routed to {route}" (Pattern 13, ViewDialog): an intro line, then a section per chosen model ("People chose {model}") with a bordered list. Each message is plain text, clamped to four lines with Show more, a muted line "Sep 28. Chose {model}. Kept until Oct 5.", then Add to a route (a menu of the other routes, never the one people left, those on the chosen model first, then "New route with {model}") and Dismiss (final, no confirmation). Add to a route closes the list and opens the route dialog with the message as the last example line, a warning note above the examples ("Edit this message before you save. ..."), focus in the examples with the caret at the end. With capture off, the card ends with one muted line: "Turn on Record prompts and replies in Workspace settings to review these messages."
- The app follows the backend's routing, not the boards' (ADR 0094): the closest route is used when it clears its threshold, so the table has no order and no reorder controls; Edit route shows two thresholds and no lead field; only two signals exist; a route's name is its slug. Edit route has a Description under Name and Model, and Try a phrase says when a route matched on its description (ADR 0122), or on its examples and description (ADR 0125).

## Requests and traces

- Routes: `/workspaces/:workspaceId/requests`, `/workspaces/:workspaceId/requests/:requestId`
- Roles: admins see everyone's requests. Members see their own, with no Person filter (ADR 0095); not drawn.
- Mockups: `Requests.html` (filters in a search landmark, table, Newer and Older paging), `Trace.html` (a request that moved to a cheaper model, with a tool approval wait), `Trace-Refused.html`.
- Parts: trace steps as an ordered list of disclosures (Pattern 8), a summary aside that comes after the steps in reading order.

## Workspace settings

- Route: `/workspaces/:workspaceId`
- Roles: admins and members, with different content.
- Heading: Workspace settings. The intro names the workspace: "Product workspace. Its people, keys and settings. Nothing here is visible to other workspaces."
- Mockups: `Workspace.html` (Workspace settings), `Workspace-Member.html`, `Workspace-Collapsed.html` (collapsed menu)
- Admin sections: Members, Invites, API keys, Model providers (workspace keys override instance keys), Content capture (Pattern 12).
- Member sections: a note that admins manage the workspace, Members (read-only), Your API keys, Content capture as read-only rows.

## Tools

- Route: `/workspaces/:workspaceId/tools`
- Roles: workspace admins. A member who opens it is sent to Your connections.
- Mockups: `Tools.html` (tool servers, the tools per server with Enabled and Asks first switches, standing approvals), `Tools-Add.html` (add a tool server dialog, with the shared-credential warning and agreement checkbox)
- Switches are correct here because the change applies at once. Everywhere else, options that wait for Save are checkboxes.

## Your connections

- Route: `/workspaces/:workspaceId/connections`
- Roles: everyone
- Mockup: `Connections.html` (accounts connected for per-person tool sign-in, tools you can use, your standing approvals)

## Instance admin

- Routes: `/admin/workspaces`, `/admin/people` (tabs: `/admin/people` and `/admin/people/sign-in`), `/admin/models` (tabs: `/admin/models` and `/admin/models/providers`), `/admin/tools` (no board; see Routes with no board), `/admin/spend`, `/admin/retention`, `/admin/diagnostics`
- Roles: instance admins only
- Boards: `Admin.html` (People tab), `Admin-Signin.html` (Sign-in providers tab), `Admin-Models.html` (Models tab), `Admin-Providers.html` (Model providers tab), `Admin-Spend.html`, `Admin-Retention.html`, `Admin-Diagnostics.html`, `Admin-Dialogs.html` (Add a model, Replace a provider key), `Admin-Workspaces.html` (Workspaces), `Admin-Workspace-Dialogs.html` (Create, Rename and Delete a workspace).
- Workspaces: the first item in the Admin group. Create workspace top right, an info note, then a table: the name as a link to its Workspace settings, admins, people, spent this month, created, Rename and Delete. A line under the table counts workspaces and people. No paging, since an instance has a handful of workspaces. Create workspace and Rename open form dialogs (Pattern 13). Create workspace asks for a name and the first admin; the name for links is made from the name (ADR 0102). Delete uses the typed confirmation (Pattern 10): an alertdialog listing what goes and how many people keep their accounts; Delete workspace stays aria-disabled until the typed name matches. Afterwards focus goes to the table and the status line says the workspace was deleted (ADR 0104). Instance spend lists a deleted workspace's spend with "(deleted)" after its name.
- People and sign-in: one page, one menu item, two underline tabs (Pattern 15). People is first, Sign-in providers second. The subtitle under the page title describes the open tab and changes with it, the same as on Spend and budgets. The tabs come right after the header. The menu item stays current on both tabs, and each tab has its own address so a link can open either one.
  - People tab: search, info note, table, Previous and Next paging below the card. Phone: `Phone-People.html`, where row actions collapse into one actions menu per row.
  - Sign-in providers tab: an OIDC provider form. Client secret is write-only, redirect URI read-only with Copy, allowed email domains as a tags field (ADR 0109), a checkbox for creating accounts, Remove provider bottom left, Cancel and Save provider bottom right. "Add a provider" sits top right of the page while this tab is open. Remove provider's confirmation is not drawn (ADR 0097).
- Models and providers: the same structure. Models is first, Model providers second.
  - Models tab: the catalogue, and models you added, with Add a model opening a dialog. Under them, Price updates (not drawn; ADR 0116): a card with an On or Off chip, a switch row (Get price updates, with the host it contacts and that the host sees the server address), whose prices apply, what the last check found, who last switched it, and Check now while it is on. Locked off by the operator, the switch is replaced by one line saying so; with no feed key in the build, the switch stays and is disabled, with one line saying why. A catalogue model priced by an update has a Price updated chip after its name.
  - Model providers tab: instance keys with a Check action and result text, Replace key opens a dialog. Add a provider opens a dialog that is not drawn (ADR 0097).
- Instance spend: instance cap, where the money went, instance alerts. "Open the full report" sits top right of the page, as a link styled as a secondary button with the coins icon from Spend and budgets. It opens the instance report at `/admin/spend/report`: the same layout as a workspace report, with By workspace added.
- Retention: settings rows with day fields, Last run with an inner table and Run now, trace export status.
- Diagnostics: a download with a note on what is removed.

## First-run setup

- Routes: `/setup/code`, `/setup/recovery-key`, `/setup/account`. `/setup` opens the first step.
- Roles: the person installing the server, before any account exists
- Mockups: `Setup-1-Code.html`, `Setup-2-Recovery.html`, `Setup-3-Account.html`
- Parts: progress as an ordered list, setup code from a command, a one-time recovery key with Copy and Download and an "I have saved" checkbox, then the admin account and the first workspace.

## Sign in and invites

- Routes: `/sign-in`, `/invite#<token>`. The token is in the link's fragment, so it never reaches a server (ADR 0098).
- Roles: signed out
- Boards: `Public.html`, `Public-Error.html`, `Public-Invite.html`, `Public-Expired.html`, `Public-Member.html`.
- SSO comes first. A wrong email or password is one alert that never says which of the two was wrong. Password reset means asking an instance admin.

## Routes with no board

- `/`: opens chat in the workspace used last, or the workspace list for someone in no workspace (ADR 0090).
- `/workspaces`: the workspaces you are in, with your role in each. Instance admins also get a link to the Workspaces page under Admin, where workspaces are created (ADR 0090, ADR 0102).
- `/reset#<token>`: choosing a new password from a reset link an instance admin made. It follows the invite page (ADR 0098).
- `/admin/tools`, Tool servers (instance admins; ADR 0117): the origins tool servers, and the sign-in services they name, may be at, for every workspace. Its own item in the Admin group, after Models and providers, with a lock icon; not a tab, since no admin page is about tools. It follows the Workspaces page: Allow an origin top right opens a form dialog with one Origin field (Pattern 13); an info note; an Allowed origins card with a table of origin (mono), Added by (a person, or the upgrade), Added and Remove, or the empty list line; Remove asks first with a plain two-button confirm (Pattern 10), then focus goes to the table and a status line says what changed. Origins the operator set in `LAKKA_MCP_PRIVATE_ORIGINS` are a read-only list in a card of their own, Set by the operator, shown only when there are any.
- On the workspace's Tools page, adding or editing a server at an origin nobody allowed fails with the form's error alert (Pattern 4). For an instance admin the alert has an Allow {origin} button, which allows it and saves again; a workspace admin is told to ask an instance admin. A server whose origin was removed says so as its last sync's failure, and Your connections names the sign-in service's origin when that is what is missing.

## Reference boards (not screens)

- `Main.html`: foundations (tokens with contrast, money states, decision types, type scale, spacing, radius, controls).
- `Theme-CSS.html`: an older view of the theme file. The file in `theme/` is newer and wins.
- `Patterns.html`, `Patterns-Dark.html`: the 15 patterns.
