# 0107. The collapsed menu, the hidden conversation list, and where the source link lives

Status: accepted; its rail heights are changed by ADR 0108. Changes ADR 0090 (web app shell) and where ADR 0085 puts the AGPL
link.

## Context

- The design adds two collapsed states (docs/design/docs/screens.md, App shell and Collapsed
  menu; boards `*-Collapsed*.html`):
  - the desktop menu collapses to a 64px rail of icons, each named by its aria-label and a
    tooltip, with every item at the height it has in the full menu;
  - on Chat, the conversation list hides, and Show conversations and New conversation move left
    of the conversation title.
  - Both are "remembered per browser and apply on every page". When a toggle is used, focus stays
    on the button that replaces it.
- The same handoff takes the "Source code" link and the AGPL sentence off every screen, to a
  Settings page that is not designed yet, and asks where the source offer goes meanwhile. AD-6
  and AGPL section 13 need the offer for every network user, and the open questions say not to
  ship without one.
- The design leaves open how the choice is stored, whether the server draws it, and how the
  tooltips behave.

## Decision

- **Two first-party cookies**, `lk_nav=rail` and `lk_conversations=hidden`, as the workspace used
  last already is (`lk_workspace`). Browser storage was the other choice, but the server renders
  the menu: with a cookie it draws the collapsed layout, and a page never paints wide and then
  jumps. Only the collapsed state is stored; no cookie means the full layout. The cookies hold no
  personal data and are read in `_app`'s `beforeLoad`, on the server and in the browser
  (`apps/web/src/lib/layout-memory.ts`).
- **Desktop only.** The rail and the hidden list apply from 1024px, where the side menu exists.
  The phone drawer always shows the full menu and the conversations.
- **Same margins.** The rail is 64px inside its 1px border (65px in all), and every item in it,
  the workspace tile and the account included, is 40px wide, so each keeps the full menu's 12px to
  either side.
- **Same heights.** Rail items keep the full menu's heights and gaps. The workspace switcher and
  Chat copy the account button's padding, 8px 10px around 28px of content, at the project owner's
  request; the switcher keeps its 1px border, and its two lines are 15px and 13px high so they fit
  the 28px. Chat is then 44px tall (the boards draw 42px) and the switcher 46px (the boards draw
  50.5px). The rail uses the same vertical padding, so no item has a fixed height. The e2e suite
  compares every item's position in both states.
- **Tooltips** are HeroUI Tooltip, placed to the right, on hover and on keyboard focus. Its
  Trigger part is not used, because it wraps the child in a div with role="button", which would
  nest one control inside another. Buttons take the trigger props themselves; links take them
  through react-aria's Focusable, on a plain anchor with the router's link props.
- **Focus** moves to the replacing button. The hidden conversation list stays mounted, so Show
  conversations always names an element that exists; its two buttons have separate ids, since
  react-aria keeps a button's id once it is set.
- **The source link moves to the account menu**, chosen by the project owner, until the Settings
  page exists. It is a menu item linking to the configured source (ADR 0085), described by "Lakka
  is free software under the AGPL." The account menu is on every signed-in page: the full menu,
  the rail and the phone drawer. The signed-out pages (setup, sign in, invites, reset links) keep
  their footer. Signed-in pages no longer have a footer, so they have no contentinfo landmark.

## Consequences

- AD-6 holds on every page, one press away instead of always visible. The e2e tests for it now
  open the account menu.
- The menu column changes width from 232px to 65px; page content is fluid and takes the space.
- When the Settings page is designed, the link moves there and this record is revisited.
