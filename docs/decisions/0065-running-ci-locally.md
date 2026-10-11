# 0065. Running the CI jobs locally

Status: accepted

## Context

- When GitHub Actions is unavailable, the checks meant to gate changes, milestone gates among them, can only be run by hand, with a working copy, one Postgres version and one architecture.
- Every CI job already runs its services in containers. The runners themselves (Node, pnpm, Playwright) are ordinary tools.

## Decision

- **`pnpm ci:local` (`scripts/ci-local.sh`)** runs the workflow's jobs on this machine:
  - `check`: typecheck, lint, format, unit tests, and migrations matching the schema;
  - `site`: the project site's checks in Chromium, WebKit and Firefox (ADR 0119);
  - `integration` on Postgres 16 and 18;
  - `image`: build, offline embedding benchmark, routing evaluation, and the size budget;
  - `out-of-process`: a tool in the app image's locked-down runner container (ADR 0073);
  - `stack`: acceptance, the SDKs, Open WebUI and LibreChat, and shutdown.
- It follows CI's conditions where they matter:
  - it tests the current commit from a fresh clone in a temporary directory, so uncommitted files cannot pass for committed ones;
  - dependencies are installed with `--frozen-lockfile`;
  - Node is the version in `.nvmrc`, through fnm when that is installed;
  - the stack starts empty, so first-run setup is required.
- **Native architecture only.** The amd64 and arm64 legs of the image and stack jobs run the same steps. Emulating the other architecture would multiply the run time, so it is left to CI.
- **The runners run on the host, the services in containers.** Running the runners inside another container would need Docker-in-Docker path mapping, and would have to reach the stack's published ports through the host gateway, for no gain in what is tested.
- **Out of the way of what is already running.** The stack is its own compose project (`lakka-ci`) on its own ports, and is removed afterwards. The compatibility scripts now take the project name, the stack's address and the two products' ports from the environment, with the old values as defaults.
- **Results:** one line per job with its time, and one log per job. The clone and its logs are removed when every job passes, unless `LAKKA_CI_LOCAL_KEEP=1` is set, and kept when one fails.

## Consequences

- A change, or a milestone gate, can be verified on a clean checkout without GitHub. The results say which architecture they cover.
- A full run takes about as long as the CI jobs one after another, since a laptop runs them in turn, not in parallel.
- The workflow file stays the source of truth. When a CI step changes, the script must change with it; the two are short enough to compare by eye.
