# Fixtures

The mockups share one consistent story. Use it for component stories, tests and seed data, so screens can be compared with the boards.

## Instance and workspace

- Server: ai.nordlys.se. Sign-in provider: Nordlys SSO (OIDC), allowed domains nordlys.se and nordlys.fi. 27 people sign in with it.
- Instance cap $5,000.00, $1,642.10 used.
- Workspace: Product. Workspace cap $1,000.00 a month, $999.60 spent, $0.40 left, resets Oct 1. That is Low.
- Report period: Sep 1 to Sep 28, 2026. 6,412 requests, 386 tool calls (16 denied), 41 moved to a cheaper model, 12 refused.

## People

- Maja Lind, maja@nordlys.se: instance admin, admin of Product and Design. Member cap $200.00, $182.40 used, $17.60 left.
- Jonas Ek, jonas@nordlys.se: admin of Product. No member cap.
- Erik Holm, erik.holm@nordlys.se: member. Cap $200.00, $35.90 left.
- Sara Nyberg, sara@nordlys.se: member of Product and Support, signs in with a password. Cap $150.00, $28.25 left.
- Lina Berg: member. Cap $100.00 a month, $88.05 used, $11.95 left.
- Nils Strand, nils@nordlys.se: member, password. Cap $10.00 a day, $7.85 left.
- Anna Virtanen, anna@nordlys.fi: suspended.
- Per Olsen, per@nordlys.se: admin of Support.
- 31 people on the server in total.

## Keys

- CI bot (lk_4Qm8...fA7), owned by Maja Lind. Cap $100.00 a month, $61.20 used.
- Support macros (lk_Tn2k...9Qe), owned by Erik Holm. Cap $25.00, never resets, used up.
- Notebook (lk_c81P...wLm), owned by Sara Nyberg. No cap of its own.

## Models and routes

- Default model Claude Sonnet 4.5. No pinned model.
- Routes, as the boards list them: Code (Claude Sonnet 4.5, 18 examples), Writing (Claude Sonnet 4.5, 14), Quick questions (Claude Haiku 4.5, 22), Translation (GPT-4.1 mini, 7 examples, needs more), Data questions (Llama 3.3 70B, off).
- Thresholds as drawn: lowest confidence 0.75, lead over the next route 0.05. The app has no lead and no route order, gives each route two thresholds, and names routes by slug, such as `quick-questions` (ADR 0094).

## The traced request

- A code question routed to Claude Sonnet 4.5. The budget hold for Sonnet was up to $0.61, more than the $0.40 left on the workspace cap, so it moved to Claude Haiku 4.5 with a $0.20 hold.
- The model asked to use a tool, which waited 18 s for approval.
- Total 23.9 s, cost $0.0073, 5,812 tokens in and 294 out.

## Model prices

The catalogue prices in the mockups are examples and were not checked against provider price lists. Do not ship them as real data.
