# 0124. Classifier weights from sentence-transformers' own ONNX exports

Status: accepted. Built in M10 (docs/roadmap.md) with ADR 0122, ADR 0123 and
ADR 0125. The measurements are arm64 unless stated; the amd64 ones are under amd64 below.

## Context

- Since ADR 0022 the classifier's INT8 ONNX weights have come from Xenova's Hugging Face
  repositories. ADR 0088 kept that source for paraphrase-multilingual-MiniLM-L12-v2, and ADR 0123
  proposed it for paraphrase-multilingual-mpnet-base-v2. No record says why. The likely reason
  is that Xenova publishes one file that runs on both architectures.
- Xenova's repositories declare no license. `models/manifest.json` records Apache-2.0 for the
  bundled export, taken from its base model, and no record checks that (CLAUDE.md,
  Dependencies). The image also ships no license text for the model, which Apache-2.0 asks a
  redistributor to give recipients.
- sentence-transformers, the publisher of both base models, has published INT8 ONNX exports in
  the same repositories since October 2024, declared Apache-2.0 in their model-card metadata. It
  publishes one file per CPU family: `model_qint8_arm64.onnx`, `model_quint8_avx2.onnx`, and two
  AVX-512 variants. Neither repository has a LICENSE file.

### The files

| Model                                                                           | File                          | Bytes       | sha256                                                             |
| ------------------------------------------------------------------------------- | ----------------------------- | ----------- | ------------------------------------------------------------------ |
| paraphrase-multilingual-MiniLM-L12-v2 @e8f8c211226b894fcb81acc59f3b34ba3efd5f42 | `onnx/model_qint8_arm64.onnx` | 118,412,398 | `783fea82d71a58179b830a4dbd2d58447e640609e98eedf9ffa12622d375a672` |
|                                                                                 | `onnx/model_quint8_avx2.onnx` | 118,453,870 | `98a01d88b7de996cdea58c32ca71208c09968d143798814b2ea09d3439dc334f` |
|                                                                                 | `tokenizer_config.json`       | 526         | `5036ea374ffedd706e3bef33e2e0d6953cb868ef8a490e76e32ba0faa37a6b9b` |
| paraphrase-multilingual-mpnet-base-v2 @4328cf26390c98c5e3c738b4460a05b95f4911f5 | `onnx/model_qint8_arm64.onnx` | 278,719,559 | `88784a4b95fd6a28e3b3b307578e2c4d12d8d550bf55d68257c8e2283f1ee901` |
|                                                                                 | `onnx/model_quint8_avx2.onnx` | 278,802,503 | `82f6b58b509e6f87a3c181fd08a94376499faa6c344eea0b36214d47d3943e61` |
|                                                                                 | `tokenizer_config.json`       | 402         | `a312d5bef89ec4c9355638520a31582e761f205d79df3002a3bd390d7077455f` |
| Both                                                                            | `tokenizer.json`              | 9,081,518   | `2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8` |

- `sentence_bert_config.json` already comes from these revisions (ADR 0088, ADR 0123).
- The AVX-512 variants are left out: not every amd64 CPU has AVX-512, and AVX2 is the baseline.

### Method

- The app image built from main with one temporary change, the embedder reading the
  hidden size from the model output (ADR 0123's first code item). The product's own
  `classifier-eval` and `embed-bench`, `--network none --cpus 2` (`--memory 4g` for the bench),
  linux/arm64 under Docker on an Apple M1 Pro. Two `embed-bench` runs per setting, 200
  iterations each.
- Two controls. The image's own model reproduces ADR 0088's figures exactly (84.3% +- 1.7 in
  English, 79.8% French, 78.4% Swedish). Xenova's weights with sentence-transformers' tokenizer
  files give results identical to Xenova's own, and the two `tokenizer.json` files tokenize all
  1,700 evaluation messages identically, so the tokenizer files are interchangeable.
- The AVX2 files' accuracy was measured by running them on arm64. Their latency, and their
  accuracy with amd64's own kernels, were measured on real amd64 hardware before acceptance
  (amd64, below).
- ADR 0122's description scenarios ran in ADR 0121's scratch harness, which reproduces ADR
  0122's and ADR 0123's Xenova figures exactly.

### Accuracy with examples

Eighteen settings: five languages, same-language and English examples, up thresholds 0.25 and
0.30, down 0.35, seeds 1 to 20.

| sentence-transformers file | Against Xenova's export          | Lowest setting at 0.35 / 0.30               |
| -------------------------- | -------------------------------- | ------------------------------------------- |
| MiniLM, arm64              | -0.5 to +0.5 points (mean +0.01) | German, same language: 77.2% (Xenova 77.0%) |
| MiniLM, AVX2               | -0.5 to +0.8 points (mean -0.01) | 77.2%                                       |
| mpnet, arm64               | -0.8 to +0.4 points (mean -0.19) | 79.98% (Xenova 80.59%)                      |
| mpnet, AVX2                | -0.7 to +0.4 points (mean -0.30) | 79.96%                                      |

Misroutes move by -0.8 to +0.9 points. Tuned on seeds 1 to 10 in English, the thresholds stay
where they were with Xenova's exports: 0.35 / 0.25 for MiniLM, 0.35 / 0.30 for mpnet.

### Accuracy with descriptions (ADR 0122)

- One route described, the other six with examples: within 0.6 points of Xenova's export for
  MiniLM and within 0.9 for mpnet, in every language, blind set and threshold, for both "today"
  and the fallback.
- Every route described: MiniLM 67.7 to 74.3% across the five languages (Xenova 68.6 to 73.8%),
  mpnet 76.1 to 81.9% (Xenova 75.8 to 81.9%).

### Latency and memory

`embed-bench`, p95 in milliseconds on the long sample (128 tokens), two runs:

| Model, export                 | 1 thread   | 2 threads | Resident after load |
| ----------------------------- | ---------- | --------- | ------------------- |
| MiniLM, Xenova                | 78 to 85   | 47 to 49  | about 655 MB        |
| MiniLM, sentence-transformers | 52 to 62   | 37 to 42  | about 660 MB        |
| mpnet, Xenova                 | 172 to 250 | 91 to 102 | about 1.0 GB        |
| mpnet, sentence-transformers  | 120 to 123 | 68 to 70  | about 1.0 GB        |

Xenova's mpnet failed the 100 ms gate (ADR 0043) in one of its two runs at two threads.

### Size

Gzipped, as pulled: MiniLM 75.5 MB against Xenova's 73.0 MB; mpnet 207.5 MB against 197.5 MB;
the shared `tokenizer.json` 3.5 MB against Xenova's 4.0 MB. Each image carries one weight file
per model, for its own architecture.

### amd64

GitHub Actions was unavailable (ADR 0086), so the measurements ran
on an x86_64 cloud host instead.

- The host: x86_64, an Intel Xeon with 4 vCPU, AVX2 and AVX-512. The image was not built
  there. Instead the host ran `pnpm install --frozen-lockfile` and
  `TARGETARCH=amd64 node scripts/fetch-models.ts`, and
  both AVX2 files matched the sha256s above. The product's own `classifier-eval` and
  `embed-bench` then ran from that source tree, mounted read-only in `node:24.21.0-trixie-slim`,
  the image's base, with `--network none --cpus 2` (`--memory 4g` for every run). The image runs
  the same TypeScript from source (ADR 0013), so Node, onnxruntime-node 1.30.0, the weights and
  the limits match CI; only the packaging differs.

Accuracy at 0.35 / 0.30, seeds 1 to 20, with misroutes in brackets for English. The two
figures per cell are with same-language examples and with English examples:

| Messages in | MiniLM, AVX2 on amd64 | mpnet, AVX2 on amd64 |
| ----------- | --------------------- | -------------------- |
| English     | 84.0 (9.6)            | 86.9 (9.9)           |
| German      | 77.3 / 77.5           | 79.9 / 82.2          |
| French      | 80.5 / 81.3           | 81.8 / 83.8          |
| Spanish     | 80.7 / 81.6           | 83.7 / 86.2          |
| Swedish     | 78.2 / 78.4           | 82.0 / 83.2          |

- Against ADR 0123's arm64 figures, MiniLM moves by -0.9 to +0.8 points and mpnet by -0.4 to
  +0.3. Each is within one standard deviation (1.0 to 2.1 points). mpnet with same-language
  German examples is 79.9%, as on arm64.
- Descriptions: "today" and the fallback (ADR 0122) are within 0.8 points of ADR 0123's arm64
  figures, in every language and blind set. Neither the fallback nor the blend (ADR 0125) is
  worse than examples alone in any set, for either model.

`embed-bench`, p95 in milliseconds on the long sample, two runs:

| Model, AVX2 on amd64 | 1 thread   | 2 threads  | Resident after load |
| -------------------- | ---------- | ---------- | ------------------- |
| MiniLM               | 65 to 66   | 52 to 55   | about 720 MB        |
| mpnet                | 203 to 211 | 133 to 148 | about 1.07 GB       |

- MiniLM passes the 100 ms gate (ADR 0043) by about 45 ms. A second VM, an Intel Xeon at
  2.10 GHz, measured 45 to 55 ms at two threads in three runs.
- At two threads mpnet is over the gate in both runs, and its median on the long sample is
  already 105 to 108 ms. Against arm64, MiniLM is about 35% slower at two threads and mpnet
  about twice as slow. ADR 0123 records what this means for mpnet.
- Reference vectors: amd64 entries in `models/reference/` written on arm64, from the AVX2 files,
  matched on amd64 at cosine 1.0 for mpnet but 0.9928 for MiniLM, under `embed-bench`'s 0.995, so
  MiniLM's amd64 entry is written on amd64.

## Decision

- **Both models come from sentence-transformers' own exports**, at the revisions above: the arm64
  image gets `model_qint8_arm64.onnx`, the amd64 image `model_quint8_avx2.onnx`, and both get the
  tokenizer files from the same repositories. No Xenova file ships.
- **The manifest names a file per architecture.** `scripts/fetch-models.ts` takes the target
  architecture: `TARGETARCH` in the image's `models` stage, as the `prod-deps` stage already does
  for onnxruntime, and the host's architecture for `pnpm models:fetch`.
- **Reference vectors per architecture.** `embed-bench --reference` checks the model file's
  sha256, so each architecture's file gets its own reference vector in `models/reference/`.
- **The image ships the license.** The Apache-2.0 text and an attribution for each model (name,
  source, revision, files, used unmodified) go into `/app/models/` beside the weights.

## Consequences

- Every shipped weight file now comes from a repository that declares its license; no license is
  inferred.
- On arm64 the classifier is faster: about 30% on MiniLM's long sample, and mpnet at two threads
  passes the 100 ms gate with about 30% to spare instead of failing it in one run of two.
- Accuracy is about the same, with one visible cost: mpnet with same-language German examples at
  0.35 / 0.30 is 79.98%, under AC 11's 80% by 0.02 points, where Xenova's was 80.59%. The
  difference is within one standard deviation; ADR 0123 records what it means for its gate.
- The two architectures run different weight files, so their vectors differ slightly. Model
  identity is the directory and a hash of the weights (ADR 0043), so an installation moved from
  one architecture to the other recompiles its routes in the background on first use, as after
  any model change. The CI image job already evaluates both architectures.
- Two files per model to pin, fetch and scan instead of one. The images grow by about 11.5
  MB gzipped with both models (ADR 0123, option A), within NF-D6.
- On amd64, accuracy matches arm64 within one standard deviation, and MiniLM meets the 100 ms
  gate. mpnet does not meet it at two threads on the hardware measured; that is ADR 0123's
  question, not this record's.
- A reference vector is written on the architecture whose file it checks. Run on arm64, the
  AVX2 file uses different INT8 kernels from amd64's. CI's amd64 image job checks both amd64
  entries on GitHub's runners once Actions runs again.
- M10 lands before the first release, so no installation outside development holds embeddings
  from the Xenova weights.
