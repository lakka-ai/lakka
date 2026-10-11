# 0121. Jev-like decision models, evaluated and not adopted

Status: accepted. Changes nothing in the product; it records why the routing
classifier stays an embedding model.

## Context

### Why we looked at Jev-like models

- Jev (TypeSafe AI, September 2026) is a hosted, closed-weights "decision model": a state and a
  set of typed questions with options in, a probability for every option out, in one forward
  pass with no text generation. Since then over a thousand open-weights repositories tagged
  `decision-model` have appeared, and a community board, Benchmark Heaven, ranks them on JevBench.
- Routing a first message to a route is the same shape: the message is the state, each route is
  an option, "none of these" is "not sure". The promise was a classifier that works from a
  route's written description, with calibrated probabilities instead of tuned similarity
  thresholds, possibly helping the routes ADR 0045 found weak, such as code.
- Jev itself is ruled out: it is a network call (RT-4) and an outbound connection (NF-P1).
- JevBench rankings do not carry over. It measures multi-step decisions over a state, where
  encoders score near zero on its "Intelligence" axis; the top entries are 4B to 31B decoders.
  Those break NF-D8: decider-4b at Q4 is 2.7 GB and takes 0.3 to 0.7 s on 8 server threads,
  needs llama.cpp as a new native runtime, and is English only (NF-A3). The tech spec already
  rejects a small generative model as the classifier. So the question had to be answered on our
  own evaluation set, with models that fit the envelope.

### What was measured

- **Candidates.** Small encoders with ONNX weights and permissive licenses, pinned by revision
  and checked by sha256:
  - `amyrmahdy/decima-small` @2e7f4d0 (Apache-2.0): multilingual-e5-small, int8 encoder and a
    two-layer scorer; options are encoded on their own, so they can be computed once per policy.
  - `Manav2op/verdict-small` @085a41e (Apache-2.0): multilingual-e5-small fine-tuned so that
    cosine x 20 is a logit over options; also usable as a drop-in embedder.
  - `SupersonicLabs/Julia-1-ONNX` @82a2fad (Apache-2.0): mmBERT-small, one cross-encoder pass
    over question, options and message together.
  - Excluded: CC-BY-NC models (`openjev/openjev`, StartLux), "other" licenses (`lev-350m`,
    `d1-omni-600M`), and every decoder of 2B and up.
- **Method.** A scratch harness, outside the repository, on onnxruntime 1.30 with no PyTorch. It
  reproduces `classifier-eval` exactly: the same mulberry32 splits over seeds 1 to 20, 12
  examples per route, all "unsure" messages as tests, messages under three words left to the
  default, thresholds tuned on seeds 1 to 10 and reported on 11 to 20. For the bundled model it
  returns the CLI's own figures (0.8426 +- 0.0162, misroutes 0.110). Julia's encoder matches its
  100 published reference logits (largest difference 0.0001); Decima matches its card's example
  outputs to 0.001.
- **Rubrics.** Route options were tested as names only and as one-line descriptions, with and
  without a "none" option, always in English while messages are in the set's language. The
  first descriptions were written after seeing the evaluation set. To remove that bias, three
  more sets were written blind by agents that saw only the product, the route names and which
  routes are cheaper, and never the set.

### Results

Held-out accuracy, %, thresholds tuned on seeds 1 to 10 and reported on 11 to 20:

| Configuration                                | en   | de   | fr   | es   | sv   |
| -------------------------------------------- | ---- | ---- | ---- | ---- | ---- |
| Bundled model, centroid of 12 examples       | 83.7 | 77.3 | 80.5 | 80.9 | 77.2 |
| verdict-small as the embedder, 12 examples   | 81.3 | 79.3 | 79.9 | 79.7 | 78.9 |
| Decima, descriptions and "none" (first set)  | 73.9 | 60.8 | 72.2 | 69.6 | 65.5 |
| verdict-small, descriptions and "none"       | 69.1 | 66.4 | 66.6 | 66.6 | 65.3 |
| Decima, route names only                     | 52.9 | 44.4 | 52.3 | 51.1 | 50.9 |
| Julia-1, route names only (its best rubric)  | 61.0 | 47.3 | 57.3 | 52.7 | 46.1 |
| Decima, each of the 84 examples as an option | 68.1 |      |      |      |      |

With the three blind description sets, every route described and none with examples, ranges
over the three sets:

| Messages in | Bundled model, description centroids | Decima, descriptions and "none" |
| ----------- | ------------------------------------ | ------------------------------- |
| English     | 72.7 to 73.8                         | 75.2 to 79.1                    |
| German      | 68.6 to 71.0                         | 66.1 to 70.4                    |
| French      | 70.1 to 71.3                         | 75.5 to 77.1                    |
| Spanish     | 72.7 to 73.0                         | 72.9 to 74.8                    |
| Swedish     | 69.5 to 70.7                         | 69.2 to 72.0                    |

Held to the bundled model's own English misroute rate (11.4%), Decima keeps 75.0 to 79.1% in
English where the bundled model with descriptions drops to 65.2 to 72.4%; at 5% misroutes the
gap is 11 to 21 points.

Request latency in onnxruntime-node 1.30.0, one message at a time, in a container limited to 2
CPUs and 4 GB (arm64), two runs:

| Model                        | p50 ms     | p95 ms     | Memory once loaded |
| ---------------------------- | ---------- | ---------- | ------------------ |
| Bundled model                | 3.0 to 3.2 | 4.3 to 4.8 | about 160 MB       |
| verdict-small                | 3.5 to 3.8 | 5.0 to 5.2 | about 105 MB       |
| Decima (options precomputed) | 58 to 60   | 71 to 72   | about 120 MB       |
| Julia-1, blockwise 8-bit     | 449 to 451 | 468 to 473 | about 440 MB       |
| Julia-1, fp32                | 616 to 630 | 653 to 662 | about 150 MB       |

Plain dynamic int8 quantization breaks Julia-1 (66 of 100 reference cases keep their answer);
blockwise 8-bit keeps 96 of 100 but stays 449 MB, its 256k-row embedding table in fp32.

### Why the decision models fall short here

- **Most of the gap is information, not architecture.** The headline compares 12 in-language
  examples against one English sentence. Given the same sentence, Decima matches or beats the
  bundled model in English and French. The set also favours centroids: examples and tests come
  from the same 40 self-written messages per route, so a centroid of near-twins is an easy
  target. Part of the 83.7% is the protocol; real traffic may narrow the gap.
- **The option interface cannot absorb examples.** Options are short (Decima 64 tokens with the
  question, Julia 48 and at most 20 options). Each example as its own option scored 68.1 +- 3.4,
  worse than descriptions: the softmax spreads mass over near-duplicates and thresholds lose
  their meaning. Nothing averages examples the way a centroid does. Routing improves by adding
  examples (RT-2, ADR 0114); these models improve by rewording a rubric.
- **Softmax confidence is relative.** A similarity is absolute, so a greeting is far from every
  centroid and falls below threshold. A softmax says which option is best, not whether any
  fits, so declining rests on an explicit "none" option. Decima's tuned setting used an up
  threshold of 0.00, leaving "none" to do all the declining; dropping "none" cost 3.6 points
  tuned and 10 untuned. Julia never chose "none". "Not sure" is central to RT-6 and ADR 0045.
- **Joint encoding couples the options.** Julia reads all options in one sequence, so they attend
  to each other: reversing their order moved its dominant pick from "writing" to "legal", both
  second in the list. It also reads about 160 tokens per request against about 13. Decima
  encodes options separately and is order-stable; that is why it is the one candidate in budget.
- **Training objective.** The bundled model was trained so paraphrases sit close together, which
  is what a centroid needs. The e5-based models were trained for asymmetric query-to-passage
  matching: Decima's encoder used as an embedder scores 71.8%, and verdict-small loses 2.4
  points in English while gaining about 2 in German and Swedish, likely from e5's multilingual
  training rather than its decision tuning. Their training mix (intent, NLI, sentiment, safety)
  is also not ours: our routes name a kind of work, not a topic. That last point is an
  explanation consistent with the numbers, not measured.
- **Wording.** Across four description sets Decima spans 73.9 to 79.1% in English and 60.8 to
  70.4% in German; the bundled model with descriptions spans 71.8 to 73.8%. With names only,
  Decima falls to 52.9%. Admins would write these sentences.

## Decision

- **No decision model is bundled.** The bundled embedding model and centroid matching stay
  (ADR 0043, ADR 0088), and so does the tech spec's rejection of a generative classifier. The
  tech spec's "Rejected" paragraph gains decision models, with this record as the reason.
- **The harness stays outside the repository.** It is Python with external weights, which the
  product does not ship (CLAUDE.md, Dependencies). The pinned revisions, the protocol and the
  numbers above are what is kept, so the measurement can be repeated.
- **The one finding worth keeping, that a route's description carries signal, is for the bundled
  model,** not a second one. Using it is proposed separately, in ADR 0122.

## Consequences

- No new dependency, no second model in the image, and the latency and memory budgets
  (NF-D8, ADR 0043) are untouched.
- Routing keeps improving the way it does now: by adding examples (RT-2, ADR 0114), which a
  decision model's option interface cannot take in.
- A workspace that writes descriptions and never adds examples is the one pattern where Decima
  measured better, by 11 to 21 points in English at a 5% misroute cap. The bundled model reaches
  69 to 74% across the five languages from descriptions alone, which ADR 0122 proposes to use.
- Revisit a decision model if real traffic shows the centroid's lead is mostly the evaluation
  set, if description-only workspaces turn out to be common, or if a decision model learns from
  examples rather than options. Decima is the first candidate: in budget (59 ms p50, about
  120 MB), int8 ONNX in the runtime already shipped, order-stable, and calibrated well enough
  to need no threshold tuning. Against it: one maintainer, an 11-day-old release when measured,
  trained on MASSIVE, and Swedish not among its evaluated languages.
