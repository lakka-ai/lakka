# 0111. An lg button is a field's height, 44px on a phone

Status: accepted. Changes ADR 0108 (buttons the same size at every width) for lg.

## Context

- ADR 0108 made buttons one size at every width, phone included: md 32px and lg 40px. Fields
  step up to 44px on a phone, as phone.md asks of touch targets.
- lg is for the main action of a page, card, list or empty state, and for a button beside a
  field. On a phone a 40px lg button sat beside a 44px field, and New conversation, 40px, sat
  among 44px rows in the menu drawer. The project owner asked for 44px there.

## Decision

- `--lk-button-height-lg` is `--lk-field-height`: 40px from 1024px, 44px below. Every lg button,
  icon-only ones included, follows.
- md stays 32px at every width, and sm 28px.
- phone.md and patterns.md say so.

## Consequences

- On a phone every lg button is 4px taller: the sign-in, setup, invite and reset pages, each
  page's main action, and New conversation.
- A field and the lg button beside it are the same height at every width, by construction.
