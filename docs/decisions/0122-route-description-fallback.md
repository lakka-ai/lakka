# 0122. A route's description stands in for its examples until it has some

Status: accepted. Built in M10 (docs/roadmap.md), which also holds ADR 0123 and
ADR 0124, both proposed when this was accepted. Uses the measurements of ADR 0121. Its "Examples
replace it" is replaced by ADR 0125: the description counts as one of the route's examples
instead of being dropped at the first one.

## Context

- ADR 0121 evaluated Jev-like decision models for routing and did not adopt one. Its one useful
  finding was that a route's one-line description carries signal. With every route described and
  none with examples, the bundled model scores 69 to 74% across five languages on three blind
  description sets (68 to 74% with the weights ADR 0124 proposes): below AC 11's 80%, but far above
  choosing no route at all.
- The blind sets were written by agents that saw only the product, the route names and which
  routes are cheaper, never the evaluation set. A set written after seeing the evaluation set
  lands inside their ranges, so the result does not depend on who wrote the descriptions.
- A route with no examples has no centroid and can never be chosen (ADR 0043). Its messages do
  not wait at the default: many go to a neighbouring route. Routes already have a `description`
  column (ADR 0042), set through the API, kept on edit but not shown (ADR 0094), and unused by
  routing.
- Measured on the realistic case: six routes keep their 12 examples at the shipped thresholds,
  the seventh has only a description, rotated over all seven routes and averaged over 20 seeds.
  "Today" is the product as it is. Accuracy % (misroutes %), recall on the new route:

  | Messages in | Today       | Description centroid, three blind sets |
  | ----------- | ----------- | -------------------------------------- |
  | English     | 76.1 (15.0) | 80.9 to 81.2 (12.6 to 13.0), 46 to 51  |
  | German      | 69.7 (26.4) | 72.5 to 73.2 (24.0 to 24.5), 28 to 35  |
  | French      | 72.4 (22.6) | 75.6 to 76.5 (20.0 to 20.7), 33 to 41  |
  | Spanish     | 73.4 (20.8) | 77.2 to 77.9 (17.9 to 18.5), 37 to 43  |
  | Swedish     | 70.9 (23.9) | 74.2 to 74.8 (21.5 to 22.1), 33 to 39  |

  These are Xenova's MiniLM export at the shipped 0.35 / 0.25. With sentence-transformers' export,
  proposed in ADR 0124, accuracy and misroutes move by at most 0.6 points. At 0.35 / 0.30, the
  default ADR 0123 proposes, the fallback adds 2.6 to 5.0 points of accuracy and removes 1.4 to 2.2
  points of misroutes, in every language and blind set (ADR 0123 has the table, for mpnet too).

- A higher threshold for the description does not pay. At +0.20 over the shipped values,
  misroutes fall by at most 0.4 points while recall on the new route drops to 7 to 14%.
- Recall varies by route, over the three blind sets and five languages: legal 64 to 88%,
  translate 33 to 65%, brainstorm 23 to 62%, data 19 to 56%, code 26 to 46%, writing 11 to 36%,
  summarize 4 to 40%. Routes whose descriptions blur into a neighbour gain least.

## Decision

- **A route with no examples is scored against its description.** When a policy is compiled, a
  route that has no examples and a non-empty description gets a centroid made from the
  embedding of `<name>: <description>`, the rendering measured above. It is stored with the
  model that produced it, like any centroid, and marked as coming from the description.
- **Examples replace it.** As soon as a route has one example, its centroid comes from its
  examples only. The description is not blended in: that was not measured.
- **The same thresholds.** A description centroid uses the route's own `threshold_down` and
  `threshold_up`. A separate, higher default was measured and only lost recall.
- **The description goes on the route dialog**, under the name, with help text saying it lets a
  new route be chosen before it has examples and that examples work better. ADR 0094 kept it off
  the dialog because routing did not use it; the screen follows the backend, and now it does.
- **Try a phrase** says when a route scored from its description, and names as unscored only
  routes with neither examples nor a description.
- **The evaluation covers it.** `packages/core/eval/routing-v1.descriptions.json` holds the three
  blind description sets, with how they were written. `classifier-eval` gains a mode that runs
  the one-new-route rotation, and CI fails if the fallback raises misroutes or lowers accuracy
  against no fallback, in any of the five languages.
- **Requirements.** A new RT-12: the classifier SHOULD be able to choose a route that has a
  description and no examples, with accuracy limits documented.

## Consequences

- A new route can be chosen from the moment it is saved. On the evaluation set, with one route
  described and the rest trained, accuracy rises about 3 to 5 points in every measured language and
  misroutes fall about 2 points, because the new route's messages stop landing on its
  neighbours.
- About a third to a half of the new route's messages reach it, depending on language and on how
  distinct its description is. The guide says a description is a start, and twelve examples are
  still the advice.
- No new dependency, no larger image, and no extra work per request: the description is embedded
  once at compile, by the model already loaded. A model change recompiles description centroids
  like any other (ADR 0043).
- One migration: a column on `route_centroids` saying where the centroid came from. Recompile
  triggers that look for routes with examples also look for routes with only a description.
- The description is admin-written policy, like examples: stored in the database, never logged
  (invariant 9).
- A workspace that only ever writes descriptions gets 68 to 74% across the five languages with
  MiniLM (with ADR 0124's weights), below AC 11's 80%, and 76 to 82% with mpnet (ADR 0123,
  proposed). AC 11 stays measured
  on examples. Decima measured better than MiniLM for that pattern; if it turns out to be common,
  ADR 0121 says what to revisit.
