# Spike A: multi-arch image with in-process ONNX embedding

Milestone M1. Decisions: ADR 0022, 0023, 0024.

## Question

Can one Debian-slim image, built for `linux/amd64` and `linux/arm64`, load onnxruntime-node and a baked-in INT8 embedding model, embed text with no network access, and meet the latency and size limits (RT-4, NF-D4, NF-D5, NF-D6, classification p95 under 100 ms)?

## Answer

Yes, on both architectures, on native 2 vCPU hardware (the NF-D8 reference size).

## Method

- `lakka embed-bench` runs inside the app image with `docker run --network none`. It times the model load, then embeds three fixed inputs 200 times each after 10 warm-up runs: short (46 chars), medium (243 chars) and long (1571 chars, truncated to 256 tokens).
- Correctness checks: 384 dimensions, unit norm, a related pair scoring well above an unrelated pair, cosine 0.995 or better against a reference embedding produced natively on darwin/arm64, and ONNX Runtime's telemetry directory neither created nor touched.
- The CI job `image` runs this on GitHub's native `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64) runners, both 2 vCPU, at one and two intra-op threads.
- Locally, the same image was also built as a single multi-platform image (`docker build --platform linux/amd64,linux/arm64`). The amd64 variant passed every correctness check under QEMU; its latency was not measured, because emulation makes it meaningless.

## Results (CI, native runners, no network)

| Arch  | Threads | Load   | RSS    | Short p95 | Medium p95 | Long p50 | Long p95 |
| ----- | ------- | ------ | ------ | --------- | ---------- | -------- | -------- |
| amd64 | 1       | 140 ms | 185 MB | 3.1 ms    | 15.1 ms    | 50.0 ms  | 70.8 ms  |
| amd64 | 2       | 138 ms | 181 MB | 2.9 ms    | 10.4 ms    | 49.3 ms  | 50.5 ms  |
| arm64 | 1       | 128 ms | 173 MB | 2.3 ms    | 8.7 ms     | 52.1 ms  | 52.6 ms  |
| arm64 | 2       | 113 ms | 170 MB | 1.9 ms    | 5.9 ms     | 28.0 ms  | 28.9 ms  |

- Every correctness check passed on both architectures. Cosine against the darwin/arm64 reference rounds to 1.000000; the semantic pair scored 0.72 (related) against about 0.00 (unrelated).
- Pulled size of our images (gzip of `docker image save`): amd64 197 MB (app 149, Caddy 48), arm64 187 MB (app 140, Caddy 46). The budget is 1000 MB (ADR 0023).

## Findings

1. **ONNX Runtime 1.30 has telemetry on by default on Linux and macOS.** It persists a device id and uploads events to Microsoft. We disable it in code before the native module loads; CI checks it on every run (ADR 0024). Every ORT upgrade needs this re-checked.
2. The onnxruntime-node tarball ships every platform's binaries (about 300 MB). The image keeps only its own architecture's, and denies the postinstall that downloads CUDA libraries on x64.
3. Latency is well inside the 100 ms budget. The worst case is a 256-token input on amd64 with one thread (p95 70.8 ms). Typical prompts (medium) take 6 to 15 ms, under 5% of a typical time to first token.
4. Output is consistent across darwin/arm64, linux/arm64 and linux/amd64 to six decimal places, even though the INT8 kernels differ.
5. The loaded classifier adds about 170 to 185 MB of RSS. That matters on the 4 GB reference host (NF-D8) and is one more reason to keep it lazily loaded.

## For M3

- Keep one intra-op thread as the default: it meets the budget and leaves the second vCPU for request handling. Revisit with the concurrency test (50 conversations).
- Classification only runs once per conversation (RT-7), so the load time (about 130 ms) and the long-input latency are paid rarely.
- The route-accuracy evaluation set from discovery is still needed before thresholds are tuned. The model can be swapped without code changes (NF-A3).
