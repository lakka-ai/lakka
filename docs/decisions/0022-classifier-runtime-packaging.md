# 0022. Classifier runtime and model packaging

Status: accepted; its model, and the reference embedding `models/reference/all-MiniLM-L6-v2.json` with it, are replaced by ADR 0088.

## Context

RT-4 and NF-D5 require classification with no network call and model weights baked into the image. NF-A3 requires the model to be a setting. Spike A had to pick a model, a tokenizer and a way to get the weights into the image, and prove them on amd64 and arm64.

## Decision

- Model: `all-MiniLM-L6-v2`, the INT8 ONNX export at `Xenova/all-MiniLM-L6-v2` revision `751bff37182d3f1213fa05d7196b954e230abad9` (Apache-2.0, 23 MB, 384 dimensions). Inputs are truncated to 256 tokens, the length the model was trained on, keeping the closing `[SEP]`. This is the default for M3; the model stays a setting (`LAKKA_CLASSIFIER_MODEL_DIR`).
- Runtime: `onnxruntime-node` 1.30.0 on the CPU execution provider, one intra-op thread by default (`LAKKA_CLASSIFIER_THREADS`). It is imported only when the embedder loads (CLAUDE.md: lazily loaded). A load failure raises `ClassifierUnavailableError` so callers can run with routing off (RT-11).
- Tokenizer: `@huggingface/tokenizers` 0.2.0 (Apache-2.0, no dependencies, no network code). Mean pooling and normalization are ours (`core/src/classifier/pooling.ts`).
- Weights: not in git. `models/manifest.json` pins each file by URL, size and sha256. `scripts/fetch-models.ts` downloads and verifies them during the image build and for development (`pnpm models:fetch`). Building needs huggingface.co; running needs nothing.
- Install: the `onnxruntime-node` postinstall (which downloads CUDA libraries on x64) is denied in `allowBuilds`, and `ONNXRUNTIME_NODE_INSTALL=skip` is set in the build. The CPU binaries ship in the npm tarball. The image keeps only its own architecture's binaries.
- A reference embedding (`models/reference/all-MiniLM-L6-v2.json`, produced natively on darwin/arm64) is committed. `lakka embed-bench --reference` fails if a platform's output drifts below cosine 0.995 from it.

## Consequences

- The classifier costs about 25 MB of weights and about 180 MB of RSS once loaded.
- Changing the model means a new manifest entry, a new reference, and an evaluation run (CLAUDE.md, Testing).
- Hugging Face is a build-time dependency. If that becomes a problem, the pinned files can move to our own release assets without changing anything else.

ADR 0088 replaced all-MiniLM-L6-v2 with paraphrase-multilingual-MiniLM-L12-v2 as the bundled model. The runtime and packaging decided here are unchanged.
