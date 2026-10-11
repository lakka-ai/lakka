# 0088. A multilingual routing classifier

Status: accepted

## Context

- NF-A3: route examples accept non-English text without errors, with accuracy limits documented. The requirements' note calls a multilingual model "a real v2 decision", and asks v1 not to rule one out: the classifier must be swappable through configuration.
- ADR 0022 chose all-MiniLM-L6-v2, which is mostly English-trained. ADR 0045 tuned its thresholds on the English evaluation set.
- On non-English text it was measured worse than no routing. The M7 comparison, 20 seeded splits, 12 examples per route:
  - With examples in the same language, it scored 44 to 52% accuracy in German, French, Spanish and Swedish. **48 to 56% of clearly typed messages went to the wrong route**, and it almost never declined.
  - With English examples, it scored 21 to 35%, falling back to the default model.
- paraphrase-multilingual-MiniLM-L12-v2:
  - Apache-2.0, 384 dimensions, 50+ languages, trained on 128 tokens;
  - a 118 MB INT8 ONNX export (Xenova);
  - it runs in the same embedder, with the same tokenizer library. No new code dependency.
- The user chose, among three options, to make it the default in v1.

## Decision

- **The bundled model is paraphrase-multilingual-MiniLM-L12-v2.**
  - Pinned by revision and sha256 in `models/manifest.json`, from Xenova's ONNX export.
  - `sentence_bert_config.json` comes from sentence-transformers' own repository, also pinned.
  - It replaces all-MiniLM-L6-v2 rather than joining it: one model to maintain, and a smaller image. Either can still be mounted with `LAKKA_CLASSIFIER_MODEL_DIR`.
- **The embedder reads a model's own training length**, `max_seq_length` in its `sentence_bert_config.json`: 128 here. It falls back to 256 when a model has no such file. Reading past what a model was trained on costs time and adds nothing. It is also what keeps this model inside the latency budget.
- **`DEFAULT_THRESHOLD_UP` moves from 0.20 to 0.25**, chosen by `classifier-eval --tune` on the English set (tuned on half the seeds, reported on the other half). `DEFAULT_THRESHOLD_DOWN` stays at 0.35.
  - Routes store their own thresholds, so routes saved before keep theirs. No release has shipped with the old value.
- **Evaluation sets in four more languages.** `packages/core/eval/routing-v1.{de,fr,es,sv}.json` are translations of the English set, message for message.
  - They are machine-translated in M7, and provisional like the English set until measured against real traffic.
  - `classifier-eval` gains `--set`, and `--examples-from`, which tests one language against route examples in another. The split is the same, by position.
- **CI holds the languages to 75%.** `scripts/classifier-eval-languages.sh`, in the image job, runs each language with examples in the same language and in English. English stays at 80%.
- **The results**, on the image with 2 CPUs and no network:

  | Messages in | Same-language examples         | English examples |
  | ----------- | ------------------------------ | ---------------- |
  | English     | 84.3% +/- 1.7, 11.0% misrouted | same             |
  | German      | 76.7% +/- 1.7                  | 77.1% +/- 1.7    |
  | French      | 79.8% +/- 1.9                  | 79.7% +/- 1.4    |
  | Spanish     | 81.3% +/- 1.7                  | 81.6% +/- 1.9    |
  | Swedish     | 78.4% +/- 1.6                  | 78.6% +/- 1.7    |

  Misroutes in the other languages are 14 to 21%, against 11.0% in English.

## Consequences

- **English accuracy is about the same:** 84.3% against 82.5%. Misroutes rise from 8.2% to 11.0%.
- **Other languages go from actively harmful to usable**, and one set of examples serves a multilingual team. The guide states the limits per language (NF-A3).
- **Costs, on 2 CPUs:**
  - The model loads in about 0.9 s instead of 0.15 s. It is lazy, so the first health check pays it.
  - About 250 MB more memory once loaded, within NF-D8.
  - Classifying a short message takes about 5 ms instead of 2.
  - The longest benchmark sample takes 66.5 ms instead of 96, since it now reads 128 tokens rather than 256.
  - The images grow from 214 to 272 MB.
- Stored embeddings carry their model, so existing routes recompile with the new model when next used (ADR 0043). No migration.
- Languages beyond the five measured are read by the model but not evaluated. The guide says so.
