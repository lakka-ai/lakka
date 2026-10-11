# 0083. The diagnostics bundle

Status: accepted

## Context

- Requirements and criteria:
  - AD-3: a diagnostics bundle a user can generate and attach to a support request, with credentials removed.
  - AC 17: provider credentials never appear in API responses, logs or the diagnostics bundle.
- The tech spec, Security: build the bundle by listing what goes in, not by redacting what shouldn't; redaction fails open.
- ADR 0075 H5 approved an allowlist bundle into which secrets are never read.
- The docs do not say what goes in, how it is generated, or in what form.

## Decision

- **Two ways to get it, one bundle.**
  - Instance admins download it from the Diagnostics page (`GET /api/diagnostics`).
  - The operator runs `docker compose exec -T api lakka diagnostics > lakka-diagnostics.tar.gz`, for when the web app cannot be reached.
  - Both stream the same entries from `packages/core/src/diagnostics/bundle.ts` as a tar.gz, reusing the export's tar writer (ADR 0082).
  - Nothing is sent anywhere (NF-P1).
- **What goes in**, each file built field by field:
  - `manifest.json`: format, time, who asked, build.
  - `system.json`: Node, OS, CPUs, memory, uptime.
  - `config.json`: hosts, ports and origins, and whether each secret is set.
    - The OTLP endpoint appears only as its origin, since a path or query can carry a key.
  - `health.json`: `/healthz` per component, with the classifier's state.
  - `database.json`: Postgres version and selected settings, extensions, migration count, connections by state, and every table and partition with approximate rows and size.
  - `cache.json`: listed Valkey INFO fields and the key count.
  - `instance.json`: counts by kind and state, per workspace by id; provider kind and name, whether a key and a custom address are set, and the last test's outcome; SSO provider count; budgets, reservations and recent alerts by state; retention settings and last run.
  - `jobs.json`: pg-boss jobs by queue and state.
  - `errors.jsonl`: the last day's failed spans, at most 200. Their attributes are the stored set minus the principal, acting user, credential principal and conversation ids. Their events keep only name and offset.
- **What stays out:**
  - credentials of any kind;
  - prompts, replies and tool arguments;
  - names, emails and workspace names;
  - provider, MCP and identity provider addresses;
  - logs, which the process does not keep. The manifest says how to collect them if asked.
- **A broken instance still gets a bundle.** Each part is read on its own. One that fails is written as `{ "unavailable": true }` and the rest continue, since the bundle is most needed when something is down.
  - pg-boss jobs are `null` only when pg-boss has not created its tables.
- **Build info.** `LAKKA_VERSION` and `LAKKA_REVISION` join the config (`dev` and `unknown` from source). The release pipeline sets them in the image.
- **Cross-workspace reads.** The diagnostics queries read counts and catalog facts across workspaces, never a workspace's rows, like retention does. They are instance-level facts for an instance admin or the operator.
- **Audit.** Generating the bundle through the api logs `diagnostics.generated` with the admin's id.

## Consequences

- Adding a setting, a table column or a span attribute adds nothing to the bundle until someone lists it here. The unit tests check the config and INFO allowlists with planted secrets.
- The integration test plants every kind of stored secret and checks that none appears:
  - provider keys (instance and workspace), MCP shared credentials, OIDC client secrets and the webhook secret;
  - key secrets, session tokens, passwords, the master key, the auth secret and the setup code;
  - database, cache and OTLP secrets;
  - prompts, emails and names.
  - The stack job runs the operator command in the image and compares the bundle with every installed secret file, inside the container.
- Support sees workspaces and requests by id only. Tying an id to a name needs the customer's own admin.

## Amendment: the operator command asks the api about the classifier

The operator command loaded its own copy of the classifier to check it, next to the api's copy in the same container: about 850 MiB at peak. On a Docker VM with 3.8 GiB it could be killed mid-archive, leaving a gzip header and no error. It now reads the classifier's state from the running api's `/healthz` inside the container, and loads no model. If the api does not answer, the classifier is reported `unreachable`. Its health checks wait up to 5 seconds, since `/healthz` itself waits up to 2 for providers. `health.json` from the operator command has no `classifierState`, the loading state of a classifier it no longer has; the api's download still includes it.

`scripts/diagnostics-bundle.sh` now prints the command's exit code, its log and each container's memory when it fails, and says when exit 137 means it was killed.
