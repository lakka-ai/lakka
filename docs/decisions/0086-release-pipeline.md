# 0086. The release pipeline

Status: accepted; amended by ADR 0099 (scanning).

## Context

- Requirements:
  - NF-D4: images for `linux/amd64` and `linux/arm64`, both tested in CI;
  - NF-S7: dependency and container scanning in CI, with a published process for reporting vulnerabilities;
  - NF-O6: the upgrade path is documented and tested from at least one earlier minor version.
- Acceptance criteria 1 to 3:
  - `docker compose up` reaches the first-run screen with no edits;
  - the instance starts with no outbound internet except to the model provider;
  - the pulled images are under 1 GB, and cold start takes under 30 seconds.
- ADR 0075 decisions:
  - Q3: GHCR, keyless signing and Trivy;
  - H7: upgrade from the previous tagged release, or, before the first, from main's previous merge.
- Two choices were made:
  - a release bundle, pinned by digest, over a repository whose compose file pulls from GHCR;
  - failing the scan on HIGH or CRITICAL findings that have a fix.
- Where GitHub Actions is unavailable, nothing here can push, sign or run on amd64.

## Decision

- **Images.** `ghcr.io/lakka-ai/lakka` and `ghcr.io/lakka-ai/lakka-caddy`, one manifest list each, for both architectures.
  - Each architecture is built on its own native runner and pushed by digest. The pushed bytes are pulled back and checked before anything is tagged.
  - The images carry `LAKKA_VERSION` and `LAKKA_REVISION` (build arguments, last in the Dockerfile) and OCI labels. The diagnostics bundle (ADR 0083) and the AGPL link (ADR 0085) read them.
  - Both lists are signed keylessly with cosign, through the release workflow's GitHub OIDC identity, and get build provenance and an SBOM.
  - A tag with a `-` is a prerelease and never `latest`.
- **The release bundle.** `scripts/release-bundle.ts` produces `lakka-<version>.tar.gz`: the repository's compose files, `backup.sh`, `backups/`, `LICENSE`, `SECURITY.md` and `VERSION`.
  - Every image in it is named by digest, Postgres and Valkey included, so no tag can change under a release. It builds nothing.
  - It is written with the project's own tar writer and fixed times, so the same inputs give the same archive on any host.
  - It is signed, and published with its checksum on the GitHub release.
  - The repository keeps building from source, unchanged, for development and CI.
- **Scanning.** `scripts/scan.sh` runs Trivy 0.74.0, pinned by digest, on the lockfile and on both images.
  - A HIGH or CRITICAL finding with a fixed version fails, in CI and in the release. Those without a fix are listed, not failed.
  - Exceptions go in `.trivyignore`, each with its reason. It is empty.
  - To pass, three changes were made:
    - The runtime image drops npm and corepack, from the Node base image, and never used.
    - It also drops `drizzle-kit` and every esbuild binary. pnpm links `drizzle-kit` in as an optional peer of better-auth from the workspace's own dev tools; nothing imports it or runs esbuild at runtime, and its esbuild binaries were built with old Go toolchains. The e2e suite runs on the pruned image.
    - The Caddy image is built by us from the same Caddy release, v2.11.4 (`docker/caddy`: `go.mod` pins the release and the fixed modules, `go.sum` every hash), with Go 1.26.8. Upstream's binary carries fixable Go and module vulnerabilities, and no newer Caddy release exists. When one does, bump `go.mod`, or return to copying upstream's binary once it scans clean.
- **Reporting.** `SECURITY.md` asks for reports through GitHub's private vulnerability reporting. It aims to acknowledge within 5 working days, and asks for 90 days before disclosure. It is also in the bundle.
- **Acceptance criteria 1 to 3.** `scripts/bundle-smoke.sh` runs a release bundle of the images just built, as a customer would, in the image job on both architectures.
  - AC 1, AC 3: `up` reaches the first-run screen with no error logged, in under 30 seconds from `up` with the images present. It takes about 13 seconds.
  - AC 2: from nothing again, on a compose network with no route out (`docker/compose.offline.yaml`):
    - the stack starts;
    - the first-run screen is served through Caddy;
    - `/healthz` reports the classifier loaded;
    - a request to the internet from inside fails.
  - Image size stays in the image job (`docker/image-size.sh`): 214 MB together.
- **Upgrade (NF-O6, H7).** `scripts/upgrade-test.sh`, a CI job of its own:
  - It starts the earlier version from its own source: `LAKKA_UPGRADE_FROM`, else the latest `v*` tag, else main's previous merge. A repository's first commit has no earlier version, so the test says so and passes; a shallow clone, which hides the parent, fails instead.
  - It fills the earlier version with an admin (through its operator command), a workspace with a cap, a provider, a model and a key, and a request made with it (`test/upgrade/data.ts`).
  - It upgrades in place to this commit on the same volumes.
  - It checks that every migration applied, and that the account, workspace, cap and spend, usage and the earlier request's trace survived, and that the key still works.
- **Workflows are linted.** `pnpm lint:workflows` runs actionlint 1.7.12, pinned by digest and with shellcheck, in the check job. `docs/releasing.md` says how to cut and verify a release.

## Consequences

- Without GitHub Actions, `pnpm ci:local` runs the scan, the bundle smoke and the upgrade test on this machine's architecture, but nothing can push, sign or test amd64. The first tagged release is also the first run of `release.yml`.
- A new base-image or dependency CVE with a fix fails CI until it is updated, as intended. Debian packages with no fix appear in the scan's report on every run.
- Building Caddy adds a Go toolchain to the Caddy image's build, not to the image itself.
