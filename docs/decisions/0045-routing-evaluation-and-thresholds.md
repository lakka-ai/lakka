# 0045. Routing evaluation and default thresholds

Status: accepted; its default `threshold_up` is changed by ADR 0088.

## Context

- AC 11: against a labelled evaluation set, routing picks the intended model for at least 80% of clearly typed requests, with "not sure" counted as correct where confidence is low.
- The requirements ask for the evaluation set to be a versioned artifact and the regression suite for every change to routing logic, thresholds or the embedding model.
- The tech spec gives `threshold_down` about 0.75 and `threshold_up` about 0.55 as a starting point, to be tuned against the evaluation set. It also asks for centroid and nearest-example matching to be compared.
- No evaluation set existed from discovery, so one had to be written.
- CLAUDE.md asks for a mean and its spread, never a single run.

## Decision

- **The set.** `packages/core/eval/routing-v1.json`, version 1.
  - Seven routes of 40 messages each. Four are "up" routes (code, writing, data, legal), whose model costs the same as the default or more, so they are held to the lower threshold. Three are "down" routes (summarize, translate, brainstorm), whose model is cheaper and held to the higher one.
  - 60 messages that belong to no route, such as greetings, general questions and vague requests. For these, "not sure" is the right answer.
  - It is self-written and provisional. It should be replaced or extended with real, anonymised traffic once there is some. A new file gets a new version; old results stay comparable with the old file.
- **The method.** `lakka classifier-eval` (`pnpm classifier:eval` in a checkout) embeds every message with the bundled model.
  - For each of 20 seeds it splits each route at random into examples and held-out tests. The examples build the routes exactly as saving a policy does.
  - It decides each test with `decideRoute`, the same function requests use.
  - A message is correct if it went to its own route, or, for the unsure messages, to "not sure". Accuracy is over all 340 messages. Clear accuracy, misroutes and "not sure" rates are reported separately.
  - `--tune` searches thresholds on the first ten seeds and reports the other ten, so a chosen value is never judged on the splits that picked it. The search never lets `threshold_down` fall below `threshold_up` (RT-5).
- **Results** (all-MiniLM-L6-v2@afdb6f1a0e45, mean with sample standard deviation):

  | Setting               | Examples per route | Accuracy       | Clear accuracy | Misroutes      | Unsure correct |
  | --------------------- | ------------------ | -------------- | -------------- | -------------- | -------------- |
  | Spec, 0.75 / 0.55     | 12                 | 0.23           | 0.02           | 0.00           | 1.00           |
  | Centroid, 0.35 / 0.20 | 8                  | 0.803 +- 0.017 |                | 0.077          | 0.880          |
  | Centroid, 0.35 / 0.20 | 12                 | 0.825 +- 0.013 | 0.812 +- 0.019 | 0.082 +- 0.011 | 0.867 +- 0.032 |
  | Centroid, 0.35 / 0.20 | 16                 | 0.840 +- 0.013 |                | 0.085          | 0.862          |

  Tuned on half the seeds and measured on the other half:

  | Mode                | Examples per route | Chosen thresholds | Held-out accuracy       |
  | ------------------- | ------------------ | ----------------- | ----------------------- |
  | Centroid            | 8                  | 0.30 / 0.15       | 0.812 +- 0.018          |
  | Nearest example     | 8                  | 0.30 / 0.20       | 0.737                   |
  | Calibrated centroid | 8                  | 0.50 / 0.35       | 0.815                   |
  | Centroid            | 16                 | 0.35 / 0.20       | 0.835 (misroutes 0.089) |
  | Calibrated centroid | 16                 | 0.60 / 0.45       | 0.828 (misroutes 0.112) |

  Embedding one message takes about 1.7 ms at p50 on Apple silicon.

- **Chosen defaults.** Centroid matching, `threshold_down` 0.35, `threshold_up` 0.20, no margin between the best two routes.
  - The spec's values are far above what MiniLM produces for a message against a centroid, so they send nearly everything to "not sure". They were a starting point and are replaced here, as the spec allows.
  - 0.30 / 0.15 scores slightly higher on accuracy, but sends about half as many messages to the wrong route. A misroute costs more than "not sure", which falls back to the default model.
  - Nearest example is clearly worse on this set. It is kept as a mode for the evaluation and not offered to admins.
  - Calibrated centroid divides a route's similarity by how tightly its own examples sit around its centroid. It matches centroid accuracy with more misroutes and is harder to explain, so it stays an evaluation option only.
  - A margin between the best two routes did not help at any setting tried.
- **Guidance for admins.** The routing admin UI will recommend twelve examples per route: 8 is just above the bar and the gain from 12 to 16 is small.
- **Known weakness: code.** Code messages are diverse (languages, errors, reviews, shell) and their centroid is diffuse. At the defaults only 18% reach the code route and 65% go to "not sure". The code-fence and code-file signals decide these requests before the classifier in production, so the weakness is visible here and mostly hidden there.
- **CI gate.** The image job runs `classifier-eval --min-accuracy 0.8` inside the built image, on amd64 and arm64, with no network and two CPUs. It fails if mean accuracy drops below 0.8, and writes the report to the job summary.

## Consequences

- Changing thresholds, scoring, the decision rule or the embedding model now has a number attached, and CI stops a change that breaks AC 11.
- The gate is only as good as the set. It is self-written, and the result, 0.825 against a bar of 0.8, leaves little room; a better set may move the defaults.
- Per-route thresholds remain editable, so an admin can tighten a route that misbehaves without affecting the others.
- Changing the embedding model means rerunning `--tune` and recording the result in a new ADR.

ADR 0088 replaced the bundled model with a multilingual one and moved the default `thresholdUp` to 0.25, tuned the same way.
