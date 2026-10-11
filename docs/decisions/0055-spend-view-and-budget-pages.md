# 0055. The spend view and the budget pages

Status: accepted; widened by ADR 0093 (the spend report).

## Context

- BG-11: a spend view a non-technical buyer can understand, by person, by workspace, by model and over time.
- The M4 plan set who sees what (F5): instance admins see everything, workspace admins their workspace, members their own spend. It also chose tables with plain bars and no chart library (Q4).
- Budgets (ADR 0049) and alert webhooks (ADR 0054) have endpoints but no pages.
- The roadmap allows the budget admin UI to be plain in M4. NF-A1 still applies.
- CLAUDE.md: every query on tenant data is scoped by workspace.

## Decision

- **The report comes from `usage`**, so its figures match what budgets were charged.
  - Requests are counted once each, however many attempts they took.
  - Costs include every attempt, since each was paid for.
  - A person's spend includes requests made through their keys (invariant 2).
  - Downgrades are the requests with `budget_fallback_from` set (ADR 0053).
- **Range:** whole UTC days, both ends included, up to 366 days, defaulting to the current month so far. Every day in the range is listed, including days with no spend, so the bars read as a timeline.
- **Endpoints:** `GET /api/spend` for instance admins, and `GET /api/workspaces/:id/spend` for a workspace. A workspace admin (or an instance admin) gets the whole workspace; a member gets their own spend, labelled `own`; a key gets nothing.
- **Scoping:** the instance-wide report passes the explicit list of every workspace's id to the same scoped helper, rather than querying usage without a workspace filter.
- **Pages:**
  - `/admin/spend` (in the main navigation for instance admins): the instance cap, the instance alert webhook, and the instance-wide report.
  - `/workspaces/:id/spend` ("Spend and budgets", linked from every workspace page). Admins get:
    - the workspace cap, editable only by instance admins, with a note saying so;
    - every member's cap, and every active key's cap;
    - the workspace alert webhook;
    - the workspace report.
      Members get their own cap, their keys' caps (editable, within the key-owner rules of ADR 0049) and their own report.
- **Setting a cap:** a dialog takes the amount in dollars (parsed exactly into micro-USD, never through floating point), the reset period and the alert percentages. The api's refusal of an owner raising an admin's cap is explained in plain words.
- **Charts:** none. Each breakdown is a table with the amount and requests as text, plus a decorative bar hidden from assistive technology (Q4). No chart library was added.
- **Webhook secret:** shown once, in a dialog that must be dismissed deliberately, with a copy button. The page never shows it again, even after a reload.

## Consequences

- A buyer can see where the money went, and every cap and alert can be managed without the api.
- The acceptance suite drives both pages with axe checks:
  - an instance admin sets and removes the instance cap;
  - caps a workspace and a person;
  - has a mistyped amount explained;
  - sets an alert address and sees its secret once;
  - is refused a private address;
  - picks a range.
    A member, signed in fresh, sees only their own part.
- Reports read `usage` directly; at the target size (10 to 50 people) that is fast with the existing workspace and person indexes. A rollup table can come later if needed.
