# Open questions, assumptions and gaps

Do not guess any of these. Where a recommendation is marked "build this", build it and mention it. Otherwise ask in an issue.

## Decisions not made

- Source code and AGPL notice: removed from every screen, to move to a Settings page that is not designed yet. The AGPL asks a network service to offer its source to users who interact with it. Confirm with the maintainers (and their legal advice) that a link on Settings is enough, and do not release a build that has no source link anywhere. Until then, the built app has it as the first item of the account menu on every signed-in page (full menu, rail and phone drawer), and in the footer of the public pages (setup, sign in, invites, reset links), as the project owner chose (ADR 0107).
- A "New conversation" shortcut in the side menu was suggested and not decided. Do not add it. (On desktop it exists in the chat header only while the conversation list is hidden, ADR 0107. In the phone drawer it sits with the conversations under Chat, ADR 0110.)

## Not drawn

These have no board. Each is built in the app from the rules in these docs.

- Phone versions of every screen other than the five on the Phone page and chat. Built with `docs/phone.md`.
- Widths between phone and desktop, such as a tablet. Below 1024px the app uses the phone layout (ADR 0090).
- Dark versions of setup, sign in and invites, workspace pages, tools, connections and the admin pages. Built from the tokens; dark follows the operating system (ADR 0090).
- Hover, pressed and disabled states as boards of their own. Built with the rules in `docs/patterns.md` (States).
- What members see on Requests: their own requests, with no Person filter (ADR 0095).
- Empty and error states for pages that do not show them on their board: an empty list line, an empty page, or an error alert (`docs/patterns.md`). Loading skeletons exist only on Chat and Spend.
- The confirmation for Remove provider (ADR 0097), and the Add a provider dialog on Model providers (ADR 0097).
- Workspaces on phone, and the Workspaces page with one workspace or none.
- The workspace list at `/workspaces` (ADR 0090) and the reset link page (ADR 0098).
- Trace timing bars in dark (`docs/tokens.md`).
- Tool servers (`/admin/tools`), the list of allowed tool server origins, and the Allow {origin} action in the tool server dialog's error (ADR 0117). Built from the Workspaces page and the patterns, as `docs/screens.md` describes.
- Price updates on the Models tab and the Price updated chip (ADR 0116).
- The Messages column and Review on When people choose another model, and the Messages routed to {route} dialog (ADR 0114).
- The Description field on Edit route, and Try a phrase's "Matched the description" and "Closest to its description" (ADR 0122), and "Matched examples and the description" (ADR 0125).
- The chat refusal for the per-person rate limit (ADR 0113). It uses the drawn provider rate-limit state, with the same words and the wait.

## Settled

Open when the bundle was made, decided since. The docs follow these.

- Content capture: with "Record prompts and replies" unchecked, "Keep recorded text for" is read-only, keeps its value, and says to turn recording on to change it (ADR 0096).
- Remove provider: a plain confirm that says whether anyone used the provider. When people sign in with nothing else, the admin types the provider ID, and the dialog says those people cannot sign in until a provider with that ID is added again (ADR 0097).
- Alert percentages: a tags field with no Add button. A percentage is picked from the list or typed into its search (ADR 0109).
- Password fields have a button beside the field that says Show or Hide (ADR 0098).
- Routes: the closest route is used when it clears its threshold. Route order means nothing, each route has two thresholds, and there is no lead value (ADR 0094).
- A pinned model is used for every request, but a person's own choice still wins (RT-3, ADR 0094).
- Members see each cap that applies to them, with its limit and what is left, and never anyone else's spend (ADR 0092).
- A budget is held before each request and settled when it ends, errors and aborts included (ADR 0050, ADR 0051).
- Workspace provider keys take priority over the instance keys for that workspace (PR-8, ADR 0038).
- Retention runs once a day at 03:17 UTC (ADR 0078, ADR 0097).
- Password reset works by asking an instance admin, who makes a one-time reset link on People (ADR 0098). There is no self-service reset.
- Deleting a workspace cannot be undone (ADR 0104). Access ends at once (members, keys, invites, provider keys, tools); its conversations, traces and routes are removed in the background. People keep their accounts and their other workspaces. Its spend stays in the instance report, with "(deleted)" after its name. The last workspace can be deleted too: its members then land on the "not in any workspace" list.
- Password minimum length: 12 characters, "At least 12 characters." (`PASSWORD_MIN_LENGTH` in `packages/contracts`). The boards' "[N]" is 12.
- Model prices: the app prices requests from its committed catalogue (ADR 0037), or, once an instance admin turns on price updates, from a signed update to it (ADR 0116). The prices on the boards are examples (`docs/fixtures.md`).
