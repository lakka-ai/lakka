# 0099. Debian security fixes in the images

Status: accepted. Amends ADR 0086 on scanning.

## Context

The image scan failed (NF-S7). Trivy found two
HIGH OpenSSL advisories, CVE-2026-75804 and CVE-2026-84782, in `libssl3t64` and
`openssl-provider-legacy` 3.5.7-1~~deb13u2. Debian had already published the fix,
3.5.7-1~~deb13u3. The latest `node:24.21.0-trixie-slim` still ships deb13u2, because the Node
image is rebuilt on its own schedule. ADR 0086 wants a fixable CVE to fail CI until it is fixed,
and nothing in the repository could fix it except waiting.

## Decision

Both images' final stages run `apt-get upgrade` against Debian's archive at build time: the
app's runtime stage and Caddy's Debian stage. A fix Debian has released goes into the next
build, whatever the base image's age. The images still start with no internet (NF-D5), since
this happens only when they are built.

## Consequences

- Two builds from the same commit can differ in Debian patch versions. A release pins the
  images it built by digest (ADR 0086), so what a customer runs does not change under them.
- A fixable CVE in a Debian package now fails CI only until the next build, not until the
  base image is republished. One in Node itself, or in a package Debian has not fixed, is
  handled as before.
