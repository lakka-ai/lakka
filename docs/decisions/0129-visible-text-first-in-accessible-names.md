# 0129. Visible text first in accessible names

Status: accepted.

## Context

- axe-core 4.14 runs `label-content-name-mismatch` by default; it was experimental before. It checks WCAG 2.5.3, Label in Name: a control whose name is set with aria-label or aria-labelledby must contain the text it shows, in the same order, word for word. Speech users click a control by saying what they see.
- Four patterns failed it, in `pnpm test:stories` and on the pages the e2e suite checks:
  - **Why this model** (Pattern 1). The chip shows "Cheaper model"; its name was "Why this model: Your budget would not cover Claude Sonnet 4.5, so a cheaper one answered." The mockups draw that name, and accessibility.md says the name is the full sentence, not the chip text.
  - **Budget meter** (Pattern 2). The button shows "$31.20 left" and "Your cap. Resets Oct 1"; its name was "$31.20 left of $50.00 on your cap. Resets Oct 1. Show all caps", as the chat boards draw it. In chat the header shows a short line, "Workspace, Oct 1", that the name never had.
  - **Model picker** (CH-3). The header trigger shows "Model" over "Auto"; its name was "Model" alone, from the select's hidden label. The boards draw "Model: Auto. Change model".
  - **Trace steps** (Pattern 8). A step's button shows "Holding the budget" and "4 ms"; its name is "Holding the budget, done, 4 milliseconds", as accessibility.md requires.
- The e2e suite's axe checks found the same failure on the pages, in controls the gallery has no story for:
  - **The account button**, on every signed-in page. It shows the avatar's initials, the name and the email; its name was "Account: Maja Lind".
  - **The workspace switcher**, on every signed-in page. It shows the workspace's initial, its name and the role; its name was "Workspace: Product. You are an admin. Switch workspace".
  - **Row actions** whose names put the target inside the visible words: "Make admin" named "Make Erik Holm an admin" (the example accessibility.md gave), "Make member", "Make instance admin", "Export data" ("Export the data of ..."), "Change address", "Replace key" and "Add key" on Model providers, and "Revoke" on Connections ("Stop always allowing ...").
- axe counts all text drawn inside the control, aria-hidden or not, and joins text from separate elements with no space, so "Model" over "Auto" reads as one word, "ModelAuto".

## Decision

- **A name starts with what the control shows, word for word, then adds what it does not show.** Visible parts that are separate elements are joined with a space in the markup, which renders nothing in a flex or grid box.
- **Why this model**: "{chip}. Why this model: {reason}", for example "Cheaper model. Why this model: Your budget would not cover Claude Sonnet 4.5, so a cheaper one answered." The chip, the popover and the copy are unchanged.
- **Budget meter**: the card reads its two lines, then the cap and the action: "$0.40 left. Budget low. Workspace cap. Resets Oct 1. The cap is $1,000.00. Show all caps". The header and the phone strip read their amount and short line, then the state where only an icon shows it, then the cap, the reset and the action: "$0.40 left. Workspace, Oct 1. Budget low. The cap is $1,000.00. Resets Oct 1. Show all caps". Without a short line the cap is named: "$31.20 left. Your cap is $50.00. Resets Oct 1. Show all caps". The meter's aria-valuetext is unchanged.
- **Model picker**: the trigger is labelled by its own "Model" and the chosen name, in that order: "Model Auto". React Aria's default for a select's button is the value then the label, "Auto Model", which the visible order does not match. On the phone bar, where "Model" is not drawn, the word is screen-reader text inside the button, so the name is the same.
- **Trace steps**: the name stays as accessibility.md says. The time moves out of the button: it is drawn in the same cell, aria-hidden, since the name already says it spelled out. The button spans the whole row on a CSS subgrid, so it looks, clicks and shows its focus ring as before. The bar, which is decoration, moves out with it.
- **Account button**: "{name}, {email}. Account", or "{name}. Account" without an email: "Maja Lind, maja@nordlys.se. Account".
- **Workspace switcher**: "{name}, {role}. Switch workspace", with the role as the button shows it: "Product, Admin. Switch workspace".
- **Avatars** inside those two buttons draw their initials with CSS (`lk-initials`, from a data attribute), not as text. An avatar is a picture; as text, its initials would be part of what the button shows. They were aria-hidden already and look the same.
- **Row actions** put the target after the visible words: "Make admin: Erik Holm", "Make member: Erik Holm", "Make instance admin: Erik Holm", "Export data of Erik Holm", "Change address of Ollama", "Replace key for OpenAI", "Add key for OpenAI", and "Revoke the standing approval for {tool}", as the Tools page already says it. Names that already started with the button's words ("Remove Erik Holm", "Edit cap for Lina Berg", "Revoke key CI bot") are unchanged.
- The rule stays on, and nothing is excluded from it in `test/axe.ts`.

## Consequences

- accessibility.md's lines on Why this model and on row actions now say the name starts with the visible words (this ADR). The mockups' aria-labels for the chip, the meter and the picker are out of date; this ADR and accessibility.md win over them (HANDOFF.md, Source of truth).
- Screen reader users hear the visible words first. For the chip that repeats a word or two of the reason, as in "Code route. Why this model: Routing matched the message to the Code route."
- A new control named with aria-label or aria-labelledby has to start with its visible text, or `pnpm test:stories` and the e2e axe checks fail.
- A trace step's time is no longer a click target of its own; the button under it still is, so a click on the time opens the step as before.
