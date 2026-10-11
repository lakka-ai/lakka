# 0094. The Routing screen follows the backend's routing

Status: accepted

## Context

The Routing boards (`docs/design/`, Routing, Routing-Edit, Routing-States) draw a different routing algorithm from the one the backend runs (RT-3, RT-5, ADR 0042, ADR 0045, ADR 0046):

- **Order.** The boards check routes top to bottom, and the first that is sure enough wins, with a "lead needed over the next route". The backend takes the closest route only, when it clears its threshold, with a margin of 0. Route order means nothing.
- **Thresholds.** The boards give each route one threshold. RT-5 requires two, one per direction.
- **Signals.** The boards have six signals. The backend has two: a code block and a source file name.
- **Names.** The boards name routes "Quick questions". Route names are slugs, and API clients ask for `route/<name>`.
- **Pin.** The boards say a pinned model ignores personal choices. RT-3 puts the person's choice first.
- **Classification.** The boards say "reads each message". RT-7 decides once per conversation.

## Decision

The backend wins (chosen by the project owner), and the screen says what it does:

- The routes card says the closest route is used when routing is sure enough, and that a signal sends a message to its route first. There are no reorder controls and no lead field.
- **Edit route shows both thresholds**, "when the model is cheaper" and "when it costs the same or more". The one that applies now is marked, from the route model's price against the default's, as the resolver compares them.
- Only the two signals that exist are offered.
- **The name is the slug.** The field says how replies show it ("Summaries") and that API clients ask for `route/summaries`.
- The pinned model's copy says a person's own choice still wins.
- The page intro says routing reads the first message of each conversation.
- **Try a phrase** gets the data the board draws (see the Try a phrase commit, RT-5):
  - the threshold the closest route needed;
  - routes that are off, scored and marked;
  - the two closest examples.
- Also settled on the screen:
  - Routing off keeps the pinned model row, since a pin applies with routing off too.
  - Turning a route on or off is a "Use this route" checkbox in the dialog.
  - "Fallbacks may use another provider" is a checkbox, since the api refuses a fallback from another provider without it.
  - Delete route asks with a plain confirm. A route can be made again, though its examples go with it.
  - The overrides card covers the api's 30 days, not "this month".

## Consequences

- The Routing-Edit board's lead field and four extra signals are not built. Adding them later means changing the backend and ADR 0045's evaluation first.
- A description a route may have (set through the api) is kept on edit but not shown.
