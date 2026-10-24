# 0123. A second, larger routing classifier that operators can choose

Status: accepted. Built in M10 (docs/roadmap.md) with ADR 0122, ADR 0124 and
ADR 0125. The amd64 measurement (ADR 0124) puts mpnet over the 100 ms gate, so mpnet has a
budget of its own, 200 ms. Uses the
measurements and protocols of ADR 0121 and ADR 0122; the weights come from ADR 0124.

## Context

### Why

- AC 11 asks for 80% on the evaluation set. The bundled model, paraphrase-multilingual-MiniLM-L12-v2
  (ADR 0088), reaches it in English but not in German or Swedish. In the app image, as CI runs
  it, at the shipped thresholds over seeds 1 to 20: English 84.3%, German 76.7%, Swedish 78.4%,
  French 79.8%, ADR 0088's figures. Run on macOS the same evaluation gives 78.2% for Swedish and
  80.1% for French: onnxruntime's macOS and Linux builds differ slightly, and CI runs Linux. CI
  holds the other languages only to 75%.
- ADR 0121 found no decision model worth bundling. A first follow-up asked whether a different
  scoring step on top of the bundled embedder could close the gap. Five variants were tried
  (centering on the examples' mean, two and three prototypes per route, a whitened space with
  and without the original similarity as the gate). None moved accuracy by more than its
  standard deviation, and most lost points. Adding English examples to same-language ones gave
  about 1 point.
- The remaining error lives in the embedding space. With the bundled model the right route
  ranks first for 81 to 88% of clearly typed messages, and a perfect "not sure" decision would
  still leave German at 85.5%. Writing, summarize and brainstorm blur into each other, and code
  is diffuse.
- So the next lever is the embedder. paraphrase-multilingual-mpnet-base-v2 is the larger model of
  the same family: same training recipe, same tokenizer, mean pooling, 128 tokens, 768
  dimensions.

### The candidate

- sentence-transformers' own INT8 ONNX exports of `paraphrase-multilingual-mpnet-base-v2`
  @4328cf26390c98c5e3c738b4460a05b95f4911f5, one file per architecture (ADR 0124):
  - `onnx/model_qint8_arm64.onnx`: 278,719,559 bytes, sha256
    `88784a4b95fd6a28e3b3b307578e2c4d12d8d550bf55d68257c8e2283f1ee901`;
  - `onnx/model_quint8_avx2.onnx`: 278,802,503 bytes, sha256
    `82f6b58b509e6f87a3c181fd08a94376499faa6c344eea0b36214d47d3943e61`;
  - `tokenizer.json`, the same file as MiniLM's under ADR 0124, and `tokenizer_config.json` and
    `sentence_bert_config.json` (`max_seq_length` 128) from the same revision.
- Apache-2.0, declared by the repository. Xenova's export @e5d116277351513fd260955ece953ecddde7046e
  was measured first; ADR 0124 records why both models moved to sentence-transformers' exports
  and how the two compare.
- It runs in the runtime and tokenizer library already shipped. No new code dependency.

### Method

- The first measurements came from a scratch harness outside the repository, in TypeScript on
  onnxruntime-node 1.30 on macOS, using the product's own tokenizer library and pooling code,
  with Xenova's export. Its vectors for the bundled model are identical to `classifier-eval`'s on
  the same machine.
- The figures in this record are restated with sentence-transformers' exports (ADR 0124):
  accuracy with examples and latency from the app image, as CI runs them, linux/arm64, `--network
  none --cpus 2` (`--memory 4g` for `embed-bench`), with the arm64 files; the description
  scenarios from ADR 0121's harness, which reproduces ADR 0122's tables and this record's first
  measurements exactly.
- Accuracy uses `classifier-eval`'s protocol: the same mulberry32 splits, 12 examples per route,
  all "unsure" messages as tests, messages under three words left to the default. Fixed
  thresholds are measured over seeds 1 to 20, as the CI gate does; tuned thresholds are chosen on
  seeds 1 to 10 and reported on 11 to 20.
- Latency: `embed-bench`'s three samples, 200 iterations, two runs each.
- Image size is `docker/image-size.sh` (ADR 0023) on the current images, plus the gzip size of
  the new weights.

### Accuracy with examples

Fixed thresholds (down / up), seeds 1 to 20, 12 same-language examples per route. Accuracy %
(misroutes %). Standard deviation 1.1 to 2.1 points in every cell. The first column is the
model and thresholds shipped today (Xenova's export); the others use sentence-transformers'
exports.

| Messages in | MiniLM 0.35 / 0.25 (shipped) | MiniLM 0.35 / 0.30 | mpnet 0.35 / 0.25 | mpnet 0.35 / 0.30 |
| ----------- | ---------------------------- | ------------------ | ----------------- | ----------------- |
| English     | 84.3 (11.0)                  | 83.9 (9.6)         | 86.8 (11.2)       | 87.1 (9.8)        |
| German      | 76.7 (21.2)                  | 77.2 (19.5)        | 78.9 (20.4)       | 80.0 (18.8)       |
| French      | 79.8 (17.5)                  | 80.0 (16.4)        | 80.8 (18.3)       | 82.0 (16.1)       |
| Spanish     | 81.3 (15.4)                  | 81.6 (14.0)        | 83.0 (15.5)       | 84.0 (13.7)       |
| Swedish     | 78.4 (18.6)                  | 78.2 (17.7)        | 80.4 (18.8)       | 81.7 (17.0)       |

With the English set's examples and messages in the other language, the gate's second mode
(ADR 0088):

| Messages in | MiniLM 0.35 / 0.25 (shipped) | MiniLM 0.35 / 0.30 | mpnet 0.35 / 0.25 | mpnet 0.35 / 0.30 |
| ----------- | ---------------------------- | ------------------ | ----------------- | ----------------- |
| German      | 77.1 (19.8)                  | 77.5 (17.6)        | 81.3 (17.4)       | 82.6 (15.5)       |
| French      | 79.7 (16.4)                  | 80.5 (14.3)        | 83.0 (15.2)       | 84.1 (13.4)       |
| Spanish     | 81.6 (14.4)                  | 82.0 (13.1)        | 85.1 (13.0)       | 86.4 (11.1)       |
| Swedish     | 78.6 (17.7)                  | 78.1 (16.6)        | 82.2 (16.5)       | 83.3 (14.8)       |

- mpnet with same-language German examples at 0.35 / 0.30 is 79.98%, under 80% by 0.02 points
  (79.96% with the AVX2 file). With Xenova's export it was 80.59% (ADR 0124). Every other setting
  clears 80%.
- Tuned on seeds 1 to 10 in English and reported on 11 to 20, in the image: mpnet 0.35 / 0.30
  (86.5%), MiniLM 0.35 / 0.25 (84.0%), the pairs found first with Xenova's exports. Tuned per
  language in the first measurements: MiniLM 83.9, 77.3, 80.5, 80.9, 77.2 (en, de, fr, es, sv);
  mpnet 86.4, 81.6, 82.3, 85.2, 82.6. With the English pair only, which is what a product default
  is: MiniLM 83.9, 74.9, 78.2, 80.3, 76.5; mpnet 86.4, 80.6, 81.7, 83.9, 82.9.
- In the first measurements the right route ranks first for 87 to 91% of clearly typed messages
  with mpnet, against 81 to 88% with MiniLM; it is in the top two for 95.6 to 97.6%.
- 0.35 / 0.30 suits both models: for MiniLM it keeps accuracy within -0.5 to +0.9 points of the
  shipped model and pair in every language and mode, and cuts misroutes by 0.9 to 2.1 points.

### Accuracy with the description fallback (ADR 0122)

ADR 0122's scenario: one route has only its description, the other six their 12 examples, fixed
thresholds 0.35 / 0.30, seeds 1 to 20, each route in turn, sentence-transformers' exports.
Accuracy % (misroutes %), then recall on the described route, as ranges over the three blind
sets. "Today" is no fallback. ADR 0122 has MiniLM at 0.25 with Xenova's export.

| Messages in | MiniLM, today | MiniLM, fallback                      | mpnet, today | mpnet, fallback                       |
| ----------- | ------------- | ------------------------------------- | ------------ | ------------------------------------- |
| English     | 75.8 (12.9)   | 80.1 to 80.8 (10.9 to 11.4), 41 to 49 | 78.3 (15.0)  | 83.3 to 83.7 (11.6 to 11.8), 48 to 52 |
| German      | 70.2 (24.1)   | 72.8 to 73.4 (22.2 to 22.7), 26 to 32 | 72.2 (25.1)  | 75.5 to 75.8 (22.2 to 22.4), 32 to 35 |
| French      | 72.7 (20.6)   | 75.8 to 76.4 (18.7 to 19.1), 30 to 38 | 73.9 (22.5)  | 77.2 to 77.7 (19.7 to 20.0), 33 to 37 |
| Spanish     | 73.8 (18.6)   | 77.3 to 77.9 (16.4 to 16.8), 33 to 40 | 75.2 (20.6)  | 79.0 to 79.5 (17.3 to 17.6), 36 to 41 |
| Swedish     | 71.1 (22.3)   | 74.2 to 74.8 (20.4 to 20.8), 29 to 36 | 73.5 (23.5)  | 77.0 to 77.2 (20.6 to 20.8), 34 to 36 |

- The fallback adds 3.3 to 5.4 points with mpnet, as it does with MiniLM. ADR 0122's decision does
  not depend on which model is loaded.
- Per route, in the first measurements, recall on the described route moves between routes:
  mpnet is better on legal (79 to 93%), translate (59 to 69%) and English summarize (48 to 54%),
  and worse on data in German and Swedish (7 to 17% against 19 to 29%) and on writing (3 to
  30%). At 0.30, code recall falls to 11 to 31%.

Every route described and none with examples, thresholds tuned on seeds 1 to 10 and reported on
11 to 20 (ADR 0121's second table):

| Messages in | MiniLM (ADR 0121) | Decima (ADR 0121) | mpnet        |
| ----------- | ----------------- | ----------------- | ------------ |
| English     | 72.7 to 73.8      | 75.2 to 79.1      | 79.3 to 81.9 |
| German      | 68.6 to 71.0      | 66.1 to 70.4      | 76.1 to 77.6 |
| French      | 70.1 to 71.3      | 75.5 to 77.1      | 77.1 to 79.6 |
| Spanish     | 72.7 to 73.0      | 72.9 to 74.8      | 78.6 to 79.8 |
| Swedish     | 69.5 to 70.7      | 69.2 to 72.0      | 76.9 to 79.8 |

mpnet's misroutes there are 13 to 21%. MiniLM with sentence-transformers' export gives 67.7 to
74.3% (ADR 0124). ADR 0121's comparison under misroute caps (11.4% and 5%), where Decima's lead
was largest, was not repeated for mpnet.

### Cost

Embedding only, in the app image on 2 CPUs and 4 GB, arm64, two runs, sentence-transformers'
arm64 files. Milliseconds, p50 / p95. The short sample is one sentence, the medium about 45 words
(under 64 tokens), the long one fills the 128 tokens both models read.

| Model, threads | Short             | Medium            | Long                  |
| -------------- | ----------------- | ----------------- | --------------------- |
| MiniLM, 1      | 4.7-4.8 / 5.2-5.7 | 19.1-19.7 / 20-22 | 49-51 / 52-62         |
| MiniLM, 2      | 3.6-4.0 / 4.1-6.8 | 12.5-13.1 / 13-14 | 30 / 37-42            |
| mpnet, 1       | 13.3 / 14.0-14.1  | 50.4-50.8 / 53-55 | 117 / **120-123**     |
| mpnet, 2       | 8.8-8.9 / 9.5     | 29.8-29.9 / 32-33 | 64.5-64.7 / 67.7-70.0 |

- **Latency.** The CI gate (ADR 0043) runs `embed-bench` at 1 and 2 threads and fails above
  100 ms p95 on the slowest sample. mpnet at 128 tokens passes at 2 threads with about 30% to
  spare, and fails at 1. With Xenova's export it had about 10% to spare at 2 threads in the
  first measurements and failed in one of two runs in the image (ADR 0124). Reading only 64
  tokens would bring the long sample under the gate at 1 thread, but it changes what long
  messages are classified on, which the evaluation set cannot measure (its longest message is 30
  tokens). This record keeps mpnet at its trained 128 tokens.
- **On amd64** (ADR 0124, an x86_64 host with the AVX2 files) mpnet is about twice as slow: 133 to
  148 ms p95 on the long sample at 2 threads, 203 to 211 ms at 1. Its whole classification of a
  short message stays at 15 to 22 ms p95. MiniLM is at 52 to 55 ms at 2 threads.
- **Classification is once per conversation (RT-7)**, on its first message of three words or
  more, so the extra latency is paid once per conversation, not per message.
- **Scoring** is unchanged in kind: one dot product per route, under a microsecond each at 768
  dimensions. A description centroid adds one more, and its embedding is made once, when the
  policy is saved.
- **Memory**: about 1.0 GB resident for the `embed-bench` process with mpnet, against about
  660 MB with MiniLM; within 4 GB (NF-D8). Load time 1.6 to 1.9 s, against 1.1 to 1.2 s.
- **Image size** (NF-D6, ADR 0023, limit 1 GB pulled for our images together): today `app` is
  228 MB and `caddy` 48 MB, 276 MB in all. mpnet's weights are 207.5 MB gzipped (MiniLM's
  75.5 MB, both from ADR 0124); each model's directory carries the shared tokenizer, 3.5 MB
  gzipped.

## Decision

### mpnet becomes a supported classifier, chosen by the operator

- **MiniLM stays the default.** It meets the latency budget at one thread, and installations keep
  their behaviour on upgrade.
- **mpnet is supported**, at its trained 128 tokens: pinned by revision and sha256 in
  `models/manifest.json`, one file per architecture (ADR 0124), evaluated in CI, and described in
  the guide with its accuracy per language, its latency and its memory.
- **Choosing it** is the existing setting, `LAKKA_CLASSIFIER_MODEL_DIR` (NF-A3), pointed at
  the mpnet directory. Threads stay the operator's setting, `LAKKA_CLASSIFIER_THREADS`: the
  guide says to set it to 2 with mpnet, and that at one thread a long first message takes about
  120 ms to classify on the reference hardware.
- **Switching models** needs nothing beyond a restart. Every embedding records its model
  (ADR 0042, ADR 0043): routes recompile in the background with the new model on first use,
  and description centroids (ADR 0122) with them. Switching back recompiles again.

### Packaging: both models in the one app image

- The image's `models` stage fetches every entry in the manifest for its architecture;
  `/app/models` holds both.
- Pulled size about 490 MB for `app` and `caddy` together, within the 1 GB budget. Every
  installation pulls mpnet's 211 MB whether it uses it or not.
- One image, one release pipeline, one bundle: the image matrix, signing, SBOM, scan, the
  bundle's cold and offline start and the upgrade test stay as they are. The `sandbox` and
  `egress` services run the same image (ADR 0118), so nothing else grows.
- Trying mpnet is a configuration change and a restart, which is what NF-A3 asks for.
- Rejected: two app images, the default as today and an mpnet variant under a tag suffix. It
  doubles the release and CI work (four app images, a release bundle per variant, every image
  job check per variant), and switching would mean editing the image of three services in the
  compose file, to save installations that never use mpnet about 211 MB of pull. It stays the
  path if the image budget gets tight.

### Thresholds

- **`DEFAULT_THRESHOLD_UP` moves from 0.25 to 0.30 for both models.** It is mpnet's
  English-tuned value, and for MiniLM it keeps accuracy within -0.5 to +0.9 points while cutting
  misroutes by 0.9 to 2.1 points. One default for both models keeps thresholds independent of
  which model is loaded, which matters because routes store their own (ADR 0045) and an operator
  can switch models. `DEFAULT_THRESHOLD_DOWN` stays 0.35.
- **No migration rewrites stored thresholds.** M10 lands before the first release, so no
  installation outside development has routes saved at 0.25. ADR 0088 met the same case when it
  moved this default from 0.20 to 0.25.

### mpnet's latency budget

- **mpnet is held to 200 ms p95 at two threads, on both architectures**, where MiniLM is held to
  ADR 0043's 100 ms. 200 ms is about 35% over the worst amd64 run, so a slower runner does not
  fail it, and it still catches a real regression. One figure for both architectures keeps the
  gate and the guide simple; arm64, at 68 to 70 ms, is well inside it.
- **It applies only to mpnet, which the operator chooses.** The default model still meets the
  100 ms limit in docs/requirements.md, which now says so. An operator who picks mpnet trades a
  slower first classification, paid once per conversation (RT-7), for routing accuracy, and the
  guide gives the latency on both architectures.
- The gate's one limit covers both of `embed-bench`'s checks, the slowest sample and the whole
  classification. For mpnet both are held to 200 ms; its whole classification is far below that.

### Code and CI

- **The embedder reads the vector size from the model's output** instead of fixing 384
  (`packages/core/src/classifier/embedder.ts`), and so does `embed-bench`'s `dimensions` check,
  which expects 384 today. The database needs no change: the vector column has no fixed
  dimension (ADR 0042).
- **The manifest gains the mpnet entry**, one file per architecture, and `models/reference/` a
  reference vector for each (ADR 0124), so `embed-bench --reference` checks both models.
- **CI evaluates both models** in the image job, offline, on 2 CPUs:
  - MiniLM: as today, `classifier-eval --min-accuracy 0.8` in English and 0.75 in the other
    languages, with same-language and English examples.
  - mpnet: 0.8 in English and 0.78 in the other languages, in both modes. The lowest measured
    value is German with same-language examples, 79.98%, so a 0.8 gate would fail there; 0.78
    leaves it about the margin ADR 0088 left MiniLM (0.75 against 76.7%). The seeds are fixed, so
    the result does not vary between runs, but a change to the set can move it.
  - `embed-bench` for MiniLM at 1 and 2 threads as today, and for mpnet at 2 threads against
    200 ms; mpnet at 1 thread is reported without a gate.
- **The release workflow checks both models too.** Its `embed-bench` step
  (`.github/workflows/release.yml`) checks MiniLM only, at one thread. It gains the mpnet check at
  two threads against 200 ms, with mpnet's reference vector, so a released image is held to the
  same latency gate as the image job.
- **The guide** documents both models: accuracy per language with examples and with the
  description fallback, latency at one and two threads, memory, and how to switch.

### Requirements

- AC 11 stays measured on examples. The default model meets it in English only; mpnet meets it
  in English and in seven of the eight other settings, all but German with same-language
  examples (79.98%).
- NF-A3's note gains the second model as the documented way to raise non-English accuracy.
- The classification latency limit in docs/requirements.md (under 100 ms) holds for the default
  model. Its row notes that mpnet, which the operator chooses, is held to 200 ms instead.

## Conditions before acceptance

- **amd64.** CI runs both architectures, with the AVX2 files on amd64 (ADR 0124). If amd64 is
  slower, the mpnet gate fails there.
- Met: ADR 0124 measured amd64 on an x86_64 host outside CI, since GitHub Actions was
  unavailable (ADR 0086). mpnet's accuracy matches arm64, and its latency is over the 100 ms gate (Cost,
  above). The answer is a budget of its own for mpnet (mpnet's latency budget, and answer 5).

## Answers to the open questions

1. **Packaging**: one image (option A).
2. **Routes saved with 0.25**: no migration. M10 lands before the first release, so there is
   nothing outside development to move.
3. **Threads**: left to the operator, `LAKKA_CLASSIFIER_THREADS`; the guide recommends 2 with
   mpnet.
4. **Default model**: MiniLM.
5. **mpnet over 100 ms on amd64**: keep mpnet, held to 200 ms at two threads on both
   architectures.

## Consequences

- An operator who needs non-English routing near or above 80% has a supported way to get it:
  German from 76.7% to 80.0%, Swedish from 78.4% to 81.7%, English from 84.3% to 87.1%, with 1.2
  to 2.5 points fewer misroutes (at 0.35 / 0.30 against the shipped model and thresholds).
- The default installation is unchanged except for the 0.30 default, the new weights of ADR
  0124, and a larger pull.
- A workspace that only writes descriptions gets 76 to 82% with mpnet, against 68 to 74% with
  MiniLM. This was ADR 0121's second condition for revisiting a decision model; mpnet now covers
  that case better than Decima did, without a second runtime model, unless the comparison under
  misroute caps says otherwise.
- With mpnet, classifying a long first message takes about 65 ms at two threads on arm64 and
  about 105 ms on amd64 (p95 up to 148 ms), instead of about 30 ms and 35 ms with MiniLM.
- mpnet is the one place the 100 ms classification limit does not hold. A regression that keeps
  it under 200 ms is not caught by CI; the guide's figures are the record of what to expect.
- Two models to keep pinned, scanned and evaluated. A future model change measures both, or
  retires one in a new record.
- The evaluation set limits all of this. It is self-written, the four other languages are
  machine translations, and every message is a short instruction with no pasted content.
  mpnet's lead may shrink or grow on real traffic.
