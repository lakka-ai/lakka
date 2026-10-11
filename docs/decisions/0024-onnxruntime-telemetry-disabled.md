# 0024. ONNX Runtime telemetry is disabled in code

Status: accepted

## Context

Spike A found that `onnxruntime-node` 1.30.0 on Linux and macOS includes Microsoft's 1DS telemetry client, enabled by default. When a session is created, it persists a device id and an event queue under the user's cache directory (`~/.cache/Microsoft/DeveloperTools/.onnxruntime`, or `~/Library/Application Support/...` on macOS), and uploads to `https://mobile.events.data.microsoft.com/OneCollector/1.0`. In our slim image the upload failed only because there is no CA bundle. That breaks CLAUDE.md invariant 8 and NF-P1. Source: `onnxruntime/core/platform/posix/telemetry.cc` and `telemetry_environment.h` at tag v1.30.0. ORT turns it off completely (no uploader, no device id) when `ORT_DISABLE_TELEMETRY` is truthy or a CI variable is set.

## Decision

- `loadOnnxEmbedder` sets `process.env.ORT_DISABLE_TELEMETRY = '1'` before importing the native module, overriding whatever the environment says. It is not something an admin can turn on.
- The app image also sets `ORT_DISABLE_TELEMETRY=1`.
- `lakka embed-bench` checks that ORT's telemetry directory is neither created nor modified during a run, and CI runs it on both architectures.
- A unit test checks that loading the embedder forces the variable to `1`.
- Every onnxruntime-node upgrade must re-read the telemetry source for new switches or endpoints before it is merged.

## Consequences

- Telemetry is off by construction, not by deployment configuration.
- Relying on an upstream environment variable is fragile. The runtime check in CI is what would catch a future ORT change.
- During Spike A, before this fix, two native benchmark runs on a developer Mac initialized ORT telemetry and wrote to its local event queue. Nothing from the image or from CI was affected.
