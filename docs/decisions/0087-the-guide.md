# 0087. The operator and admin guide

Status: accepted

## Context

- The roadmap makes documentation a release gate. The minimum for each release:
  - install and upgrade;
  - backup and restore;
  - a configuration reference;
  - the AGPL notice and source link;
  - a troubleshooting page covering the problems support actually runs into.
- ADR 0075 H8: the M7 gate's clean-machine run follows only `docs/guide/`.
- Requirements that call for documentation:
  - API-5: budget refusals as a documented error;
  - OB-6: the retention defaults;
  - NF-S6: TLS in every documented deployment;
  - NF-O6: the upgrade path;
  - NF-A3: classifier accuracy limits for non-English text.

## Decision

- **Pages.** `docs/guide/` has one page for each job:
  - install;
  - administration;
  - the API;
  - configuration;
  - operations;
  - backup and restore;
  - upgrade;
  - troubleshooting;
  - licence and source.

  The index is `docs/guide/README.md`. The repository README points to it and keeps only a quick start and the development commands.

- **Written from the code.** UI labels, error codes, headers, settings and defaults are taken from the code, not from memory.
- **Install is from the release bundle**, with the download verified by checksum and cosign signature. A source checkout is the alternative.
- **Only HTTPS is recommended for more than one machine** (NF-S6).
  - The default listens on this machine only.
  - A domain gets a certificate from Let's Encrypt through Caddy.
  - Plain HTTP on a network address is described as possible, and as unencrypted.
  - A local-network certificate (`tls internal`) is not supported yet, and the guide says so.
  - HSTS is left to the operator (ADR 0085).
- **NF-A3.** The guide gives the measured accuracy: 82.5% with twelve examples per route, on the English evaluation set (ADR 0045). It then states plainly that accuracy on other languages has not been measured, since the bundled model is mostly English-trained, and says what to expect and do: fewer confident routes, examples in the users' language, **Try a phrase**, and signals.
- **Errors (API-5).** The API page lists every code a client can receive, with its HTTP status, what it means and whether to retry. `budget_exceeded` is set apart as a 402 with its own `type`.
- **Link and style checks.** Every relative link and anchor in the guide was checked, along with the ASCII and prose rules in CLAUDE.md.

## Consequences

- The install page's main path needs a published release. Before the first release, a clean-machine run uses the source-checkout path the page also gives.
- Two known gaps are documented, not closed:
  - non-English routing accuracy (NF-A3) is unmeasured; an evaluation set in other languages would replace the caveat with numbers;
  - local-network TLS is unsupported.
- A change to UI labels, settings or error codes must update the guide in the same pull request.
