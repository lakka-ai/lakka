# 0090. The web app shell: theme, menu, phone layout and where `/` goes

Status: accepted; its fonts are replaced by ADR 0101, and its menu is changed by ADR 0107.

## Context

- `docs/design/HANDOFF.md` is the approved UI design. It asks for the theme, bundled fonts and the app shell first: a side menu with Chat set apart, an Admin group for admins, the AGPL notice on every page, and a phone top bar and drawer.
- Some things the design leaves open or does not draw:
  - the breakpoint between the phone layout and the side menu (`docs/design/docs/phone.md` says to pick one);
  - how dark mode is chosen, when the theme selects it with a `dark` class;
  - what the workspace switcher and the account row open, and where Sign out lives;
  - which workspace the menu shows on pages whose address names none, such as the admin pages;
  - what `/` shows. The old home page was the workspace list, where instance admins also create workspaces.
- The design and the handoff disagree on the notice. The side menu boards show "Source code" and "AGPL". The handoff asks for "Lakka is free software under the AGPL." next to the link on every page and in the drawer. The handoff ranks higher.
- The boards put the menu's footer inside `<nav>`. A footer inside a nav is not the page's `contentinfo` landmark, which `docs/design/docs/accessibility.md` asks for.

## Decision

- **Theme.** `docs/design/theme/lakka-theme.css` is copied into `apps/web/src/styles/` because the image build does not see `docs/`, and a unit test keeps the two identical. The fonts come from `@fontsource/schibsted-grotesk` and `@fontsource/ibm-plex-mono` (OFL-1.1) and are served by the app (NF-P1).
- **Dark mode follows the operating system.** A script in the head, with the page's CSP nonce (ADR 0085), sets `dark` on `<html>` before the body paints, and follows the setting while the page is open. The design draws no switch. Without script the page stays light.
- **Breakpoint 1024px.** From there the 232px side menu leaves room for the tables. Below it, the phone layout is used: top bar, drawer (HeroUI Drawer, `placement="left"`, on react-aria's modal, so it traps focus, closes on Esc and returns focus to Menu) and the notice at the end of the page. The two layouts are switched with CSS, so the hidden one is out of the accessibility tree and there is one main menu and one page footer.
- **Menu.** One model (`apps/web/src/components/shell/nav.ts`) feeds the side menu and the drawer. Routing and Tools show for workspace admins and instance admins, who may manage every workspace. The Admin group shows for instance admins. This only decides what is linked. The api decides what anyone may see.
- **Workspace switcher.** A menu of the person's workspaces with their role, the current one checked, and "All workspaces". Switching keeps the page when the other workspace's menu has it, and otherwise opens its chat.
- **Account.** The account row is a button named `Account: <name>` that opens a menu with Sign out.
- **The workspace used last** is kept in a first-party cookie (`lk_workspace`, the id only), because the server renders the menu too. It is checked against the person's workspace list every time. The order: the workspace in the address, then the one used last, then the first they belong to.
- **`/` opens chat** in that workspace. The workspace list, with creating a workspace for instance admins, moves to `/workspaces`. Someone in no workspace lands there. The MCP flow's `/?mcp=` outcome is passed on to it.
- **The notice** uses the handoff's sentence everywhere. In the side menu it sits on two lines under the link. The menu's footer is a sibling of `<nav>`, so it is the `contentinfo` landmark. In the drawer, which is a dialog, it is not a `<footer>`, so there is never a second `contentinfo`.
- **Routes keep their addresses** (`/workspaces/:id/chat`, `/admin/users` and so on). `docs/design/docs/screens.md` calls its routes proposals to adapt, and renaming them would break links for no gain.

## Consequences

- e2e tests that started at `/` on the workspace list now start at `/workspaces`. Links repeated on Workspace home ("Also for this workspace") and in the menu are clicked through the Main navigation.
- `test/e2e/shell.spec.ts` covers the landmarks, the current page, the switcher, the account menu, dark mode, no sideways scroll at 390px, and the drawer's focus handling, with axe on each.
- The pages inside the shell are not restyled yet. They follow in the order the handoff gives.
