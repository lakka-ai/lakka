# 0093. What the Spend screens are told

Status: accepted; its alert field is changed by ADR 0109 (a tags field). Widens ADR 0055 and ADR 0079 on the spend report.

## Context

- The Spend boards (`docs/design/`, Spend-Admin, Spend-Budgets, Spend-Member, Spend-States) draw more than the api sent:
  - an API key as its own row under By person;
  - model names; routes with their model, and rows for the default and for a person's own choice;
  - what the cheaper-model requests cost, refusals by why, and tool calls denied by the person;
  - speed and size per model, with time to first token;
  - what a member or key with no cap has used;
  - a webhook address saved on its own, a new secret on its own, and a test alert;
  - a banner for when budgets cannot be checked.
- A person's cap counts their keys' spend (invariant 2). The board's By person rows add up to the total only when a key's spend is on its own row.
- A new cap starts from zero: `budget_spend` has no rows for the period before it existed. So does an existing cap given a new period.

## Decision

- **By person lists who sent the requests** (chosen by the project owner): each person's own, and each key's on its own row with its owner. Every dollar is counted once. A member's own report still includes their keys, and the Member caps table still shows a cap's use with their keys.
- **By route groups by how the model was picked**:
  - each route (a conversation's earlier routed decision and a signal included), with the model it sends to now;
  - the default, when no route was sure enough;
  - the person's own choice, overrides of a route included;
  - the pinned model.
- **Refusals come from traces**: root spans that ended in `budget_exceeded`, `budget_unavailable`, `rate_limited`, `forbidden`, `no_model` or `unsupported_input`. A provider failure is not a refusal. Traces are kept 30 days by default (OB-6), so a longer range counts refusals only as far back as that.
- **Tool calls** are counted as ran (ok, failed, timed out), not allowed for the person (TL-5), and denied by the person when asked (TL-4, from `tool_approvals`). The board lists "Tool not allowed for this person" as a refused request. It is not one: the model is told and the reply goes on. It is shown with the tool calls.
- **Speed and size by model** gives the median and 95th percentile of total time, time to first token, and tokens in and out, over completed replies.
- **`/budgets` lists this calendar month's spend** (UTC) of every person and key, capped or not, as `monthSpend`, for the Used column of those with no cap. A member gets their own and their keys'.
- **The set-a-cap dialog** says what is already used only for an existing cap whose period is unchanged. For a new cap, or a new period, nothing is used yet.
- **Webhooks**: PUT still creates or replaces a webhook with a new secret.
  - PATCH changes the address and keeps the secret.
  - POST `.../secret` makes a new secret, shown once. The old one stops working at once.
  - POST `.../test` sends a signed `budget.test` event now and returns whether it arrived. It is not queued, retried or kept in the alert history. A workspace webhook's test keeps to public addresses.
- **`GET /budgets/status`** says whether budgets can be checked, by pinging Valkey with a 2 second timeout. Anyone who reads budgets in the workspace may ask.
- **Copy follows the backend.** Caps reset at midnight UTC, not server time.
- **On the screens**, where the boards do not settle it:
  - The Spent tile is read against the workspace cap only when this month is shown and the cap is monthly. Another range shows the amount alone.
  - A member's card for the tightest cap shows "Smallest, shown in chat" and, when it is low or used up, that chip too, so the state is said in words.
  - A key's owner keeps Set a cap and Edit cap on their own keys (Q1). The member note says so after "Only workspace admins can change your cap".
  - Make a new secret asks first, with a plain confirm, since the receiver stops trusting alerts until it has the new one. Stop sending alerts stays, as it was, also behind a plain confirm.
  - The alert field has an Add button as well as Enter, as `docs/design/docs/open-questions.md` recommends.
  - The report's cheaper-model and refusal rows, and a member's Cheaper model used and Refused tiles, link to the Requests list filtered to that outcome over the same dates. Custom dates lead to every request kept, since the list has no custom range. Tool rows have no link: the list does not filter by tool.

## Consequences

- An instance admin's report lists keys too, with their owners.
- Refusal counts depend on trace retention, and are marked as coming from traces.
- A test alert reaches out from the api process. It goes only to the webhook the admin set, when they press the button (NF-P2).
