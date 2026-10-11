# 0092. What chat is told about models, replies, budgets and failures

Status: accepted. Widens ADR 0061 on what a member sees of a cap.

## Context

- The chat design (`docs/design/`) says more about each reply than the api sent:
  - model names such as "Claude Sonnet 4.5";
  - "Confidence 92%", the reply's cost, and "Used repo.search" while it streams;
  - which key a pending approval belongs to;
  - how much a refused message needed and how much was left;
  - which provider did not answer, and how long a rate limit asked to wait;
  - each cap with its size;
  - the routes' models, and whether routing is on.
- The project owner chose to add all of it, and chose display names made from ids and editable for custom models.
- ADR 0061 kept the limits of caps a member cannot otherwise see hidden, and gave only the tightest headroom. The owner chose that members see each cap that applies to them, with its limit and what is left, and never anyone's spend by person.

## Decision

- **Display names.** `modelDisplayName` in contracts makes one from a provider id. Custom models may set their own (`custom_models.display_name`, migration 0024). `ModelView.displayName` is always set.
- **Stored with each reply** (migration 0025): the classifier's confidence, the default's reason, and the cap that sent the reply to a cheaper model.
- **Worked out when a conversation is read:**
  - model names;
  - the request's cost, on its last reply, summed from usage;
  - each server-side tool call from the audit (TL-6): arguments, outcome, duration, whether it asked first. Calls are matched by id within the conversation, because an approved call runs in the request that continues the first.
- **In the stream and headers**, as extensions OpenAI clients ignore:
  - `x-lakka-routing-confidence`, when the classifier ran;
  - `lakka.tool_activity {call_id, name, status}` as each call finishes. It never carries arguments or results.
- **On errors**, a `lakka` extension with the details. Status codes and error codes are unchanged, so SDK retry behavior is too.
  - A budget refusal gets its scope, what is left, and what the request needed.
  - A provider failure gets the provider of the last model tried, whether it was rate limited, and its Retry-After.
- **Budgets.** `/budgets/remaining` also lists each applicable cap (member, workspace, instance) with its limit, what is left, its period, and where the meter turns low. The low point is computed on the server, so the alert settings are not sent.
- **`/requestable`** gives each route its first model and name, each model its display name, and routing on or off with the default and pinned models.
- **A pending approval made by the owner's key names the key.**
- **Accessibility checks leave out react-aria's live announcer** (`[data-live-announcer]`, in `test/axe.ts`). It is a visually hidden log of announcements already made, such as a conversation being selected. An entry points at the announced element for seven seconds, and axe reports it once that element has been redrawn. This is the second exception after ADR 0091's meter fallback role.

## Consequences

- A member learns the size of the workspace and instance caps and their aggregate use. Before, they learned only the tightest headroom.
- Tool arguments are read back from the audit only for the conversation's owner (invariant 9, ADR 0066).
- The cost of an old reply disappears when retention removes its usage rows.
- Extension fields are additions. The compatibility suites (official SDKs, Open WebUI, LibreChat) are the check that clients ignore them.
