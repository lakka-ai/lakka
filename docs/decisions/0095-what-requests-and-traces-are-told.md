# 0095. What the Requests and trace screens are told

Status: accepted. Widens ADR 0079 on the request list and ADR 0076 on stored span attributes.

## Context

- The Requests, Trace and Trace-Refused boards (`docs/design/`) draw more than the api sent:
  - filters for person, surface, outcome and dates, and a count of every match;
  - an outcome word with its reason on each row ("Cheaper model, workspace cap would not cover Sonnet", "Code route, 0.91");
  - a Checking access step, and the model the person asked for;
  - what the cap that had no room had left;
  - a Waiting for approval step between the request that asked and the tool that ran.
- A tool approval ends the request. The approved call runs in a new request, which carries the answer. The two had no link.
- Rows that started at the same moment could be skipped between pages, because the cursor was the start time alone.

## Decision

- **One trace across an approval** (chosen by the project owner):
  - `tool_approvals` records the request that carried the answer, and whether it was for always (migration 0026). The continuing request's own span names the request it continues.
  - The list shows the first request only, with the chain's time and cost.
  - Either request opens the same trace. Every step of both hangs from the first request, and the approvals give the wait.
- **Outcomes**: completed, cheaper, refused, stopped, failed.
  - Refused means one of the refusal codes of ADR 0093.
  - Failed means any other error, or a reply that broke off.
  - Stopped means the person stopped it.
  - The list filters by the first request. A chain reads as failed or stopped when its last request did.
- **The request span carries what the list says**: what was asked for, the rule, route, confidence and threshold, the cap and what it had left, the cheaper model, and the provider that did not answer.
  - Ids, codes and numbers only, added to the stored attributes on purpose (ADR 0076).
  - The model a cap moved a model call away from gets its own name, `lakka.budget.fallback_from`. `fallback_model` was used for both directions.
- **The list** takes `person` (admins only; a member always reads their own), `surface`, `outcome`, and `from` and `to` as UTC days.
  - It returns `total`.
  - Its cursor is the start time and span id, so no row is skipped.
  - The filters read span attributes with no new index. A workspace of 10 to 50 people has thousands of requests in 30 days of traces, and the root-span index narrows each query to the workspace.
- **The budget step** says what the first model could cost, what the cap that had no room had left, and what the cheaper model could cost and was held. The board's table of every cap against every candidate is not drawn. Getting it would mean reading every cap's counter on each request's path.
- **Access** is its own step, `policy.authorize`.
- **Not shown**, where the boards draw them:
  - the conversation's title in the summary. It is text someone wrote, and the design does not say an admin may read it.
  - "other requests refused at the same time". That is other people's activity.
  - a short request id. The id is the UUID.
- **Members** see their own requests, as ADR 0079 says, with no Person filter.

## Consequences

- Filtering by outcome or person scans the workspace's root spans for the dates chosen. If that grows slow, promote those attributes to columns with an index.
- Trace retention (30 days) and tool record retention (90 days) differ. An old approval may point at a request whose trace is gone. That request's steps are then missing, and the wait is still shown.
