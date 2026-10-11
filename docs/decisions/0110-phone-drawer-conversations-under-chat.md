# 0110. In the phone drawer, chat's conversations sit right under Chat

Status: accepted. Changes the order drawn on the Chat-Phone-Nav board.

## Context

- On a phone, the main menu and chat's conversations share the menu drawer
  (`docs/design/docs/accessibility.md`, Chat; `docs/design/docs/phone.md`). The Chat-Phone-Nav
  board draws Chat, the workspace pages, then New conversation and the conversations, so they
  came after the workspace and admin pages, far down the drawer for an admin.
- The project owner asked for the conversations right under Chat.

## Decision

- In chat, the drawer reads: Chat, its conversations (New conversation, then the list), then the
  workspace pages, the Admin pages and the account.
- The conversations keep their own navigation landmark, Conversations, now inside the main
  menu's. A line sets them apart from Chat above and the other pages below.
- `NavList` takes what to show under Chat (`afterChat`); the drawer passes chat's conversations,
  and the side menu and rail pass nothing. On desktop the conversations stay in their own column.

## Consequences

- With many conversations, the other pages are further down the drawer. The drawer scrolls.
- Outside chat nothing is shown under Chat, and the drawer is as before.
