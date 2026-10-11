# 0002. Contributions use the Developer Certificate of Origin

Status: accepted

## Context

Outside contributions need a sign-off policy. The main options are the DCO (a `Signed-off-by` line per commit) and a CLA (a signed agreement granting extra rights).

## Decision

Contributions use the DCO. `CONTRIBUTING.md` explains it, and the `dco` CI job (`scripts/check-dco.sh`, also `pnpm check:dco`) checks that every commit of a pull request is signed off by its author.

## Consequences

- Lower friction for contributors than a CLA.
- No right to relicense contributed code. That fits ADR 0001 and the roadmap's commitment that the hosted and self-hosted editions stay identical.
