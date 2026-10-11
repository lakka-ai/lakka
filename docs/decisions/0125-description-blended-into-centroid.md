# 0125. A route's description counts as one of its examples

Status: accepted. Built in M10 (docs/roadmap.md), with ADR 0122, ADR 0123 and
ADR 0124. Replaces ADR 0122's "Examples replace it"; the rest of ADR 0122 stands. Uses ADR
0122's evaluation protocol and description sets, and ADR 0124's weights.

## Context

- ADR 0122 scores a route that has no examples against the embedding of `<name>: <description>`,
  and drops the description as soon as the route has one example. It did not measure blending
  the two, so it did not do it.
- `classifier-eval --fallback` also reports, for information, a new route with 1, 2 and 4 of its
  own examples and no description. That report showed the switch makes things worse: one example
  scores below the description alone, and only about two examples match it. A new route gets
  worse the moment an admin adds its first example.
- Two ways out were measured: keeping the description until the route has two examples, and
  counting the description as one more example in the centroid, at every example count.
- Measured in an app image built from main (linux/arm64, `--cpus 2`), with sentence-transformers'
  weights (ADR 0124), at the default thresholds 0.35 / 0.30, seeds 1 to 20, 12 examples per
  route, examples in the same language as the messages. The new route is rotated over all seven
  routes, as in ADR 0122; the others keep their 12 examples and no description. Ranges are over
  the three blind description sets. The blended runs used a scratch patch to `classifier-eval`,
  not committed; building this ADR commits that measurement.

  MiniLM, a new route: accuracy % / recall on the new route %

  | Messages in | Description alone           | 1 example   | 1 example and description   | 2 examples  | 2 examples and description  |
  | ----------- | --------------------------- | ----------- | --------------------------- | ----------- | --------------------------- |
  | English     | 80.2 to 80.8 / 41.4 to 48.6 | 78.8 / 29.9 | 81.4 to 81.7 / 55.4 to 58.8 | 80.7 / 48.7 | 82.3 to 82.4 / 64.7 to 66.5 |
  | German      | 72.8 to 73.4 / 25.6 to 32.6 | 72.5 / 25.9 | 74.5 to 74.9 / 44.5 to 48.6 | 74.1 / 40.8 | 75.5 to 75.6 / 54.8 to 57.0 |
  | French      | 75.7 to 76.3 / 30.6 to 38.4 | 75.5 / 30.6 | 77.3 to 77.7 / 47.6 to 52.3 | 77.1 / 46.7 | 78.2 to 78.4 / 57.7 to 60.2 |
  | Spanish     | 77.3 to 77.9 / 33.3 to 40.1 | 76.8 / 30.3 | 78.8 to 79.1 / 49.7 to 53.2 | 78.5 / 47.3 | 79.8 to 80.0 / 59.2 to 62.5 |
  | Swedish     | 74.2 to 74.8 / 29.6 to 36.9 | 73.8 / 28.6 | 75.6 to 75.9 / 45.5 to 48.9 | 75.3 / 43.6 | 76.5 to 76.6 / 55.4 to 57.6 |

  mpnet (ADR 0123), a new route: accuracy % / recall on the new route %

  | Messages in | Description alone           | 1 example   | 1 example and description   | 2 examples  | 2 examples and description  |
  | ----------- | --------------------------- | ----------- | --------------------------- | ----------- | --------------------------- |
  | English     | 83.3 to 83.7 / 48.3 to 52.3 | 81.5 / 32.2 | 84.7 to 85.0 / 62.4 to 65.0 | 83.6 / 53.1 | 85.5 to 85.6 / 70.4 to 71.8 |
  | German      | 75.5 to 75.7 / 32.2 to 34.8 | 74.8 / 28.3 | 77.2 to 77.4 / 50.6 to 52.6 | 76.8 / 48.8 | 78.3 to 78.4 / 62.1 to 63.7 |
  | French      | 77.0 to 77.5 / 32.6 to 37.2 | 76.5 / 28.8 | 79.0 to 79.2 / 51.5 to 54.4 | 78.5 / 49.1 | 80.0 to 80.2 / 62.7 to 64.2 |
  | Spanish     | 79.3 to 79.7 / 36.5 to 40.7 | 78.4 / 30.4 | 81.0 to 81.3 / 54.2 to 56.9 | 80.6 / 51.4 | 82.2 to 82.3 / 65.5 to 66.4 |
  | Swedish     | 76.9 to 77.1 / 33.7 to 35.9 | 76.1 / 28.9 | 78.7 to 78.8 / 52.2 to 53.8 | 78.3 / 50.1 | 79.7 to 79.9 / 63.1 to 64.5 |

- Keeping the description until two examples removes the dip, but the blend beats it at both
  counts: on the same description set, at one example it is 0.8 to 2.0 points above the
  description alone, at two 1.2 to 2.0 points above two examples alone. Misroutes are lower in
  every cell. The blend keeps its lead
  at 3, 4 and 6 examples, narrowing as examples accumulate.
- At 12 examples, with every route described, which is AC 11's setting plus descriptions:
  accuracy % (misroutes %)

  | Messages in | MiniLM, examples | MiniLM, examples and description | mpnet, examples | mpnet, examples and description |
  | ----------- | ---------------- | -------------------------------- | --------------- | ------------------------------- |
  | English     | 83.9 (9.6)       | 84.6 to 84.9 (9.0 to 9.3)        | 87.1 (9.8)      | 87.6 to 87.7 (9.4 to 9.6)       |
  | German      | 77.2 (19.5)      | 77.3 to 77.5 (19.3 to 19.4)      | 80.0 (18.8)     | 80.8 to 81.2 (17.7 to 18.1)     |
  | French      | 80.0 (16.4)      | 80.7 to 80.8 (15.6 to 15.8)      | 82.0 (16.1)     | 82.9 (15.2 to 15.4)             |
  | Spanish     | 81.6 (14.0)      | 82.4 to 82.8 (13.0 to 13.5)      | 84.0 (13.7)     | 84.9 to 85.2 (12.5 to 12.8)     |
  | Swedish     | 78.2 (17.7)      | 78.8 to 79.0 (17.2 to 17.4)      | 81.7 (17.0)     | 82.2 to 82.5 (16.2 to 16.4)     |

  The gains, 0.1 to 1.3 points with misroutes 0.1 to 1.2 points lower, are inside one standard
  deviation over seeds (1.1 to 2.1 points),
  but the comparison is paired on the same splits and points the same way in all 30 combinations
  of model, language and description set. Per route, accuracy moves by -1.6 to +4.1 points; the
  worst is translate in English with MiniLM and one blind set. The share of ambiguous messages
  correctly left "not sure" moves by -1.2 to +2.7 points.

- No count was found at which the description stops helping, so there is no cutoff to choose.

## Decision

- **The description is one more example.** When a policy is compiled, a route with a non-empty
  description gets the embedding of `<name>: <description>` (ADR 0122's rendering) added to its
  example embeddings, with the weight of one example, and its centroid is the mean of them all.
  With no examples that is the description alone, as in ADR 0122; with no description it is the
  examples alone, as before ADR 0122. There is no example count at which the description is
  dropped.
- **The same thresholds**, as in ADR 0122.
- **A third centroid source.** `route_centroids.source` gains `examples_and_description`, by a new
  migration that widens its check (forward only). `CentroidSource` in `contracts` gains it too.
- **Stale centroids rebuild themselves.** A route whose stored source is not the one its examples
  and description call for is stale, like a centroid from another model (ADR 0043): the first
  request that sees it starts a background recompile, and the old centroid keeps scoring until
  the new one is in. This is how existing workspaces pick the rule up after an upgrade. Changing
  a route's name or description drops a centroid of either description-bearing source, as ADR
  0122 does for description centroids now.
- **The screen follows.** The route dialog's help text says the description is used with the
  examples from the first save, and that examples still count for more. Try a phrase says a
  route was scored from its examples and description.
- **The evaluation gates it.** `classifier-eval --fallback` measures, for every description set,
  the new route with 1, 2, 4 and 12 examples with and without its description, and every route
  described at 12 examples, replacing the informational report. CI fails if the description
  lowers accuracy or raises misroutes in any of these but the new route at 12, in any of the five
  languages, for either bundled model. The new route at 12 is reported only: it passes by 0.01
  to 0.03 points for MiniLM in German, which rounding or another architecture's numerics could
  flip. AC 11's gate stays measured on examples alone:
  a workspace need not write descriptions.
- **Requirements.** RT-12 becomes: the classifier SHOULD use a route's description, alone before
  the route has examples and alongside them after, with accuracy limits documented.

## Alternatives

- **Keep the description until two examples.** Fixes the dip, measured above, and nothing else.
  The blend is better at every count and needs no threshold on the count.
- **Blend until some count, then drop.** At 12 examples the description still helps, so a cutoff
  would remove a gain and add a step change the admin cannot see.
- **Weight the description more than one example.** Not measured. One example's weight needs no
  tuning against the evaluation set; anything else would be chosen on it (ADR 0045).

## Consequences

- A new route no longer gets worse when it gets its first example. With one example, accuracy is
  1.8 to 3.4 points above ADR 0122's rule, and recall on the new route rises from 26 to 32% to
  45 to 65%, depending on language and model.
- Trained routes with a description gain a little: 0.1 to 1.3 points at 12 examples. The guide
  can say a description helps at any stage, not only before examples.
- A description now affects a trained route too, with the weight of one example: one thirteenth
  at twelve. The blind sets describe what each route is for; a description written for people
  (an owner's name, a ticket link) was not measured. The guide says what a description is for,
  and Try a phrase shows the effect of editing one.
- Renaming a trained route changes its centroid, since the name is part of the embedded text.
  The rename already recompiles the policy.
- No new dependency and no work per request: compile embeds one more text per described route,
  as it already does for routes without examples. One migration widening a check constraint.
  The upgrade test (NF-O6) covers a route with examples and a description recompiling to the new
  source.
- It joins M10's scope in docs/roadmap.md, before M10's gate.
