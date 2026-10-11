# 0075. Observability and release hardening: scope and decisions

Status: accepted

## Context

- M7's goal (roadmap): someone who didn't build the product can run it and diagnose problems.
- Its scope:
  - trace storage with partitioning and retention, and the trace UI;
  - content capture toggles and retention settings;
  - OTLP export;
  - usage analytics views;
  - the diagnostics bundle;
  - backup and restore;
  - health endpoints and graceful shutdown;
  - the AGPL source notice;
  - documentation;
  - the multi-arch release pipeline.
- Its exit criterion: every acceptance criterion passes on a clean machine, run by someone following only the published documentation.
- The M7 plan put five questions to the user, who chose the recommendations (Q1 to Q5), and approved the smaller decisions (H1 to H8).

## Decision

- **Scope:**
  1. trace store;
  2. content capture;
  3. retention;
  4. trace UI and usage views;
  5. OTLP export;
  6. health and shutdown;
  7. export and deletion;
  8. diagnostics bundle;
  9. backup and restore;
  10. web hardening;
  11. release pipeline;
  12. documentation;
  13. the M7 gate.
- **Q1, default retention periods:**
  - spans 30 days, and captured content 7 days;
  - usage 13 months;
  - conversations kept until deleted;
  - the tool audit (`tool_invocations`) 90 days, and decided approvals and revoked grants 90 days;
  - budget alerts 13 months, and settled reservations 30 days.
  - All are instance settings, except captured content's period, which a workspace sets with its opt-in. Every period can be changed.
- **Q2, runtime dependencies**, from the OpenTelemetry project, Apache-2.0:
  - `@opentelemetry/sdk-trace-base` 2.11.0 for the tracer provider and batch processor;
  - `@opentelemetry/exporter-trace-otlp-http` 0.222.0 for OTLP export.
- **Q3, releases:**
  - images are published to GitHub Container Registry (`ghcr.io/lakka-ai/lakka`), signed keylessly through GitHub's OIDC;
  - dependencies and containers are scanned with Trivy (Apache-2.0).
  - This needs GitHub Actions.
- **Q4, backup:**
  - a `backup` compose service on the Postgres image, whose `pg_dump` matches the server;
  - it writes one `.tar.gz` of the database dump and the secrets, and restore works the same way, with api and worker stopped;
  - the file is unencrypted in v1, readable only by its owner, and documented as holding the master key.
- **Q5:** deployment under a subpath (NF-C4) is deferred to v1.x. Only root-path deployment is documented.
- **H1, who sees traces:**
  - instance admins see all of them, and workspace admins their workspace's;
  - members see their own requests, from a link on each chat reply;
  - nobody sees another workspace's (AC 16).
- **H2:** flagging an unsatisfactory reply (OB-7, a SHOULD) is deferred to v1.x.
- **H3, spans in Postgres:**
  - status and duration are columns, attributes are JSON, and there is never content;
  - indexes by workspace and time, and by request.
- **H4, retention settings:**
  - instance admins set the periods on an admin page;
  - the content opt-in and its period are on the workspace page, visible whether on or off.
- **H5:** the diagnostics bundle is built from an allowlist of what goes in, not by redacting a dump. Secrets are never read into it.
- **H6:** a strict Content-Security-Policy, and the e2e suite fails on any violation.
- **H7:** the upgrade test starts from the previous tagged release (for the first release, main's previous merge), fills it with data, upgrades, and checks the data survives.
- **H8:** the clean-machine run, on a clean Ubuntu host and an Apple Silicon Mac, follows only `docs/guide/` and is recorded in the gate.

## Consequences

- The gate needs both architectures in GitHub Actions (AC 1 to 3, NF-D4). Where GitHub Actions is unavailable, `pnpm ci:local` stands in wherever it can.
- Subpath deployment and response flagging are known gaps in v1, listed in the gate.
