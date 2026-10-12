# Releasing

A release is a tag such as `v1.2.0` (or `v1.3.0-rc.1` for a prerelease) on a commit of `main`
whose CI has passed. Pushing the tag runs `.github/workflows/release.yml` (ADR 0086). The first
release was `v1.0.0-beta.1`.

1. Check that the commit's CI passed on both architectures, and that the gate for the milestone,
   if it is a milestone release, is recorded in `docs/gates/`.
2. Tag and push:

   ```
   git tag -a v1.2.0 -m 'v1.2.0' && git push origin v1.2.0
   ```

3. The workflow then:
   1. builds each image on native amd64 and arm64 runners, with the version and commit baked in,
      and pushes them by digest only, with provenance and an SBOM. The build takes Debian's
      security fixes (ADR 0099), so these images can differ from CI's build of the same commit;
   2. pulls those exact bytes back and checks them:
      - the Trivy scan of the lockfile and both images (`scripts/scan.sh`);
      - the size budget;
      - offline embedding;
      - the release bundle starting cold and offline (`scripts/bundle-smoke.sh`);
   3. only then makes one manifest list per image. It tags them `v1.2.0`, and `latest` unless
      it is a prerelease:
      - `ghcr.io/lakka-ai/lakka`
      - `ghcr.io/lakka-ai/lakka-caddy`
   4. signs both lists keylessly with Sigstore and attaches build provenance;
   5. builds `lakka-v1.2.0.tar.gz` with `scripts/release-bundle.ts`. Its compose files name
      every image, Postgres and Valkey included, by digest; the `sandbox` and `egress` services
      run the app image, so there is no third image of ours (ADR 0118). It is signed with
      `cosign sign-blob`, and published with its `.sha256` and its `.sigstore.json` on a GitHub
      release whose notes are generated from the merged pull requests.

Nothing is tagged or published if any check fails. Delete the tag, fix, and tag again.

## Publishing a price update

Instances that turned on price updates fetch `feed/catalogue-v1.json` from `main` once a day
(PR-6, ADR 0116). Publishing new prices is a pull request, separate from a release or part of one:

1. `pnpm catalogue:update` regenerates `packages/core/catalogue/models.json` and raises its
   `serial`. Review the diff: it changes what every request is billed.
2. `LAKKA_FEED_SIGNING_KEY=/path/to/key.pem pnpm catalogue:sign` signs the file with its serial
   into `feed/catalogue-v1.json`. It refuses a key that `packages/core/src/models/feed-keys.ts`
   does not list, and checks the result before writing it.
3. Commit both files in the same pull request, so `main` never has a catalogue newer than its
   feed. Delete the key file from disk.

Instances apply the new prices within a day. They refuse the whole feed if it cuts a bundled price
below a quarter, makes a model free, lowers a long-context tier, or prices a provider other than
Anthropic, OpenAI or Google. `pnpm test` checks that the committed feed verifies and matches
`models.json`.

### The signing keys

- **Custody.** The owner makes two keys with `pnpm catalogue:keygen <path>` on an offline machine:
  a primary and a backup. Each private key goes into the password manager and nowhere else; the
  command refuses to write inside the repository, and the file is deleted after copying. Both
  public keys, as the command prints them, are added to `PRODUCTION_FEED_KEYS` in a reviewed
  commit. Both are in `feed-keys.ts` (primary `616cb5edac72f3f2`, backup `6a849a50e2d7ef0e`),
  and the committed feed is signed with the primary.
- **Signing** needs the key on disk only for the moment of `catalogue:sign`, mode 0600.
- **Compromise.** If a private key is lost or suspected: stop using it, publish a security
  advisory naming its key id, remove it from `feed-keys.ts`, release, and sign the next feed with
  the other key at a higher serial. Then make a new backup key and add it in the following
  release. SECURITY.md says what operators do meanwhile.

## Verifying a release

```
sha256sum -c lakka-v1.2.0.tar.gz.sha256
cosign verify-blob lakka-v1.2.0.tar.gz \
  --bundle lakka-v1.2.0.tar.gz.sigstore.json \
  --certificate-identity 'https://github.com/lakka-ai/lakka/.github/workflows/release.yml@refs/tags/v1.2.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify ghcr.io/lakka-ai/lakka@sha256:<digest from the bundle's docker/compose.yaml> \
  --certificate-identity 'https://github.com/lakka-ai/lakka/.github/workflows/release.yml@refs/tags/v1.2.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Before a release, on this machine

GitHub Actions is the source of truth. When it cannot run, `pnpm ci:local` runs every CI job on
this machine's architecture:

- the scan and the bundle's cold and offline start, in the image job;
- the upgrade from the previous release, in the upgrade job.

It cannot push, sign or test the other architecture.

## The project site

The landing page (`docs/index.md`) and the guide (`docs/guide/`) are published as a website on
GitHub Pages, built by `apps/site` with VitePress (ADR 0119). It is not tied to a release:
`.github/workflows/pages.yml` builds and deploys it on every push to `main` that changes the
guide, the landing page, the site package, the theme file or the lockfile, and can be run by
hand.

- **The base path.** The site is built for the path it is served under, `LAKKA_SITE_BASE`,
  `/lakka/` by default. The workflow takes it from Pages, so moving to a custom domain
  is a setting in the repository's Pages settings and nothing here. To build or preview for
  another path locally, set it: `LAKKA_SITE_BASE=/ pnpm site:build`.
- **What it needs.** Pages enabled for the repository with GitHub Actions as its source, and
  GitHub Actions available (ADR 0086). Until both hold, the workflow cannot deploy;
  `pnpm site:check` checks the site locally and in the CI `site` job.
