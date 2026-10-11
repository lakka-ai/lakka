# 0048. Routing admin page and the override summary

Status: accepted; completed by ADR 0114 (overridden messages offered as route examples).

## Context

- RT-1, RT-2 and RT-11 need a place where workspace admins define routes with examples and turn routing on or off. NF-A1 requires it to be accessible.
- RT-10 (a SHOULD) asks for accumulated overrides shown as a suggested policy change with an estimated cost effect. The M3 plan kept it minimal (E11): overrides per route, their direction and the cost effect. Overrides store no message text until the M7 content opt-in (Q2, ADR 0047).
- The tech spec pictures an admin accepting a suggestion by adding the overridden messages as examples. Without stored text, that action is not possible in M3.

## Decision

- **One page per workspace**, `/workspaces/:id/routing`, linked from the workspace page for its admins. It has four sections:
  - Settings: routing on or off, the default model and the pinned model.
  - Routes: a table with each route's model, whether it is cheaper than the default, examples and whether they are learned, signals and status. Routes are added and edited in a dialog.
  - Try a phrase.
  - Overrides.
    The api still authorizes every call; members see a short note instead of the page.
- **Models offered** are the ones the workspace can use: priced, with a credential for their provider. The api enforces the same rule.
- **The route dialog.**
  - Fallbacks are an ordered list: each model picked is appended and can be removed. Order is failover order (E13).
  - A signal claimed by another route is shown disabled with that route's name, rather than failing on save (ADR 0042).
  - The examples field counts the lines and recommends twelve or more (ADR 0045).
  - Thresholds default to the tuned values.
- **"Cheaper than the default"** in the table uses `blendedPrice`, now in `contracts`, so the page and the resolver apply the same rule (E4).
- **Try a phrase** returns what the real resolution order would decide for a new conversation starting with the phrase: rule, model, route, signal, confidence and the reason for a default. The admin tool and requests therefore never disagree. The phrase is scored and forgotten.
- **The override summary**, `GET /api/workspaces/:id/routing/overrides?days=30` (1 to 90 days), workspace admins only. For each route people overrode, it reports:
  - the requests the route decided and people kept, and the requests they overrode. Each request counts once, by its earliest recorded attempt, since later attempts are failover.
  - how many overrides went to a model with a higher blended price, and how many to a lower one.
  - the model people chose most often (ties by name), and a cost effect: what the route's kept requests would have cost at that model's base prices, minus what they did cost. It ignores long-context tiers and any difference in token counts between models, so it is labelled an estimate. Money is integer micro-USD as a decimal string, which can exceed what a JSON number holds exactly.
  - Overrides of a "not sure" decision have no route to attribute them to and are not listed.
- **No accept button.** With no stored text there are no examples to add, and changing a route's model is one edit in the same page. The summary tells the admin which way people moved and what switching would cost. Adding overridden messages as examples arrives with the M7 content opt-in.

## Consequences

- Every routing setting in M3 can be managed without the api directly, and the acceptance suite drives the whole page with axe checks: settings, a route learned by the bundled classifier, the tester, routing off, editing and deleting.
- The override summary reads `usage`, so its numbers match the spend records exactly; it grows only with overrides and kept routed requests in the period.
- When content capture exists (M7), the summary can offer the overridden messages as examples, as the tech spec describes.
