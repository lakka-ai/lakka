# 0003. Configuration and environment loading

Status: accepted

## Context

The docs require every setting to have a working default (NF-D3) and env vars to stay stable within a major version, but do not say how configuration is loaded or validated.

## Decision

- Backend configuration is a zod schema in `packages/core/src/config.ts`. `loadConfig(env, readSecret)` is pure, so it is unit-tested without a filesystem.
- Precedence for secrets: env var, then a file in `LAKKA_SECRETS_DIR` (ADR 0004), then unset.
- All variables use the `LAKKA_` prefix (ADR 0018). Defaults match the compose service names, so the compose file sets almost nothing.
- Empty values count as unset.
- Invalid configuration throws `ConfigError` naming the variables, never their values, and the process refuses to start.
- No dotenv dependency. Development uses Node's `--env-file` with `docker/dev.env`.
- `web` has its own minimal settings (`LAKKA_WEB_HOST`, `LAKKA_WEB_PORT`), because it may not import core (ADR 0006).

## Consequences

- Env var names become part of the upgrade contract before v1.
- One schema to review when a setting is added.
