# 0018. Project name, package scope and env prefix

Status: accepted

## Context

Package names, env var names, image names and wire formats become contracts once there are installs. They all derive from the product name, so it is settled before the first release.

## Decision

The product is called Lakka, Finnish for cloudberry, the berry the Cloudberry brand colour is named after.

- Package scope `@lakka/*`; env prefix `LAKKA_`.
- The short prefix `lk`: API key secrets start `lk_`, and the web app's CSS classes, tokens and ids start `lk-` (`--lk-` for custom properties).
- The name, lowercase, everywhere else it appears: the operator command `lakka`, the compose project and its Postgres user and database, `/run/lakka`, the `x-lakka-*` HTTP headers and the `lakka` field in API errors, `lakka.*` span attributes, and export and archive names.
- Images: `lakka/app` and `lakka/caddy` for local builds, published as `ghcr.io/lakka-ai/lakka` and `ghcr.io/lakka-ai/lakka-caddy`. The repository is `github.com/lakka-ai/lakka`.

## Consequences

- After v1, env var names can only be deprecated with warnings, not removed within a major version (roadmap, Release engineering). The same holds for headers, span attributes and the API key prefix.
