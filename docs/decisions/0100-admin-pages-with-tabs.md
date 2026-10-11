# 0100. Admin pages with tabs, and Workspace settings

Status: accepted.

## Context

The Admin, Workspace, Phone and other boards (`docs/design/mockups`) changed the menu:

- People and Sign-in providers are one item, **People and sign-in**, a page with two tabs.
- Models and Model providers are one item, **Models and providers**, a page with two tabs.
- Workspace is **Workspace settings**. Its heading is the page's name, and the intro names the
  workspace ("Product workspace. Its people, keys and settings.").

The boards draw a tablist under the page's title, and do not say what address each tab has. The
app is not public yet, so no links to the old addresses (`/admin/sign-in`,
`/admin/model-providers`) need to keep working.

A first build kept the four old addresses as sibling routes, each drawing the page's header and
tabs itself. Changing tab then swapped the whole page, and keyboard focus fell back to the page's
body after the arrow keys moved to the other tab.

## Decision

- **Each tab is a route nested under its page**, as Spend's Report and Budgets and alerts are:
  - `/admin/people` is People and sign-in, its People tab the index;
  - `/admin/people/sign-in` is the Sign-in providers tab;
  - `/admin/models` is Models and providers, its Models tab the index;
  - `/admin/models/providers` is the Model providers tab.
- **The page's layout route** draws the title, the open tab's intro, the open tab's action at
  the right, and the tablist, once. The tablist stays mounted when the tab changes, so focus
  stays on the tab. Each tab's route loads only its own data, and the layout checks that the
  person is an instance admin.
- **Add a provider** is in the page's header, as the board draws it, and opens the new
  provider's form on the Sign-in providers tab through the address (`?new=true`). A reload keeps
  the form open.
- **The menu item** links to the first tab. The second tab's address starts with the first's, so
  the router marks the item current (aria-current="page") on both, and the phone bar takes its
  name on both.

## Consequences

- `docs/design/docs/screens.md` lists the new addresses.
- A tab with an action in the page header keeps that action's state in the address, since the
  header belongs to the layout and the state to the tab.
