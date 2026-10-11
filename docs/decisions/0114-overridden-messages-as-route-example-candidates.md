# 0114. Overridden messages as route example candidates

Status: accepted. Completes ADR 0048: the summary now offers the overridden
messages as examples, with the content opt-in.

## Context

- RT-10 asks for accumulated overrides shown to the admin as a suggested policy change. ADR 0048
  built the summary per route and left out the step the tech spec pictures, adding the messages
  people moved away from as route examples, because overrides store no text (ADR 0047). It
  promised that step "with M7 content opt-in", and this ADR adds it.
- Text may live only where invariant 9 says: conversation history people asked to keep,
  `span_content` for a workspace that opted in, and the capped tool audit. A copy of a message in a
  new table would be a fourth place, with its own retention and its own deletion to get right.
- The message that matters is not the override's own turn but the one routing judged: the latest
  earlier message in the conversation whose request decided its route. Only a classifier decision
  can be changed by an example; a signal decides without reading examples (ADR 0042).
- Showing a person's words to an admin on a page other than the trace is a new use of recorded
  content, so members must be told before it happens (NF-P3).

## Decision

- **Derived when read, never stored.** A candidate is found by a query, from the override's usage
  rows (the losing route; the chosen model, which after a budget fallback is in
  `budget_fallback_from`), to the override's turn in `messages` by request id, to the
  conversation's latest earlier message whose request decided its route by `signal` or
  `classified`. If that decision is `classified` for the losing route, its message is the
  candidate. Its text is read from `messages`. No table gains a text column.
- **The gate (owner decision D2).** A candidate is offered only while the workspace's content
  capture is on now, only when the deciding request was recorded (a `span_content` row for it that
  has not expired), and only while its message is kept. Turning capture off hides every candidate
  at once. Deleting the conversation or the person, conversation retention, and the expiry of the
  recorded content each remove a candidate by construction. Overrides in the last 1 to 90 days are
  read, at most 20 candidates per losing route and chosen model, newest first. `messages` gains an
  index on `request_id` for the join.
- **What is stored.** `route_candidate_decisions` keeps what an admin did with a candidate:
  message id (primary key, cascading with the message), workspace, `added` or `dismissed`, the
  route an addition went to (set null if the route is deleted), who and when. No text. A decided
  candidate is never offered again. Dismissing is final, with no undo and no confirmation (D6).
- **Adding is admin-authored policy (D1).** Add to a route opens the route dialog with the message
  as the last example line, newlines collapsed and cut to 1000 characters, focused, with a note to
  edit it and that examples are kept until removed, even after the recorded text is deleted. The
  route save carries `fromCandidates`; one transaction checks each is still offered, writes the
  examples as the admin left them and the `added` decisions, then the policy is recompiled. If one
  is no longer offered, the save is refused with `candidate_gone` (404) and the route is unchanged.
  Nothing is ever added automatically. An example then outlives its source: it is policy an admin
  wrote, like any other example. CLAUDE.md invariant 9 says so.
- **Where it may go (D3).** Never the losing route: an example there pulls more such messages to
  the model people left. The suggestion is a route whose model is the chosen one, then any other
  route, then a new route with the chosen model.
- **Who.** Listing and dismissing take `policy.manage`: workspace admins and instance admins, never
  a member or a key. Another workspace's message is not a candidate there.
- **Logs.** `routing.candidate_dismissed` with the message id, and a route save that added
  candidates logs how many. Never text (NF-S5).
- **Consent (D5).** The capture setting's help and the chat notice say that recorded text can also
  appear on the Routing page, as the message a conversation was routed on, when someone picks a
  different model.

## Consequences

- RT-10 is built as the tech spec describes: the admin sees which messages people moved away on and
  can teach the routes from them.
- Candidates exist only while capture is on, so a workspace that never records content never sees
  them; the override summary still works without.
- The query joins usage, messages and captured content per override, bounded by the 90-day window
  and workspace indexes. It runs when an admin opens the Routing page, never per request.
- The override summary now counts the chosen model after a budget fallback as the one people
  picked, not the cheaper one the cap allowed.
- An admin who adds a message copies someone's words into policy that outlives its source. The
  dialog says so before saving, and the example can be edited or removed like any other.
