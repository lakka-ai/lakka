# 0012. TypeScript 7 for typechecking

Status: accepted

## Context

TypeScript 7.0 is the native Go compiler, about ten times faster. It has no stable programmatic API until 7.1, and it changes some defaults (`types: []`, `strict` on, `baseUrl` removed).

## Decision

Use `typescript@7.0.2` for typechecking only (`noEmit`). No part of our toolchain needs the TypeScript JS API: drizzle-kit, the TanStack router generator, Vite and oxlint do not use it. If a future tool does, TypeScript 6 is installed alongside it under an alias, as the TypeScript team recommends.

## Consequences

- Fast typechecks in CI and in the editor.
- Tools built on the TypeScript API (typescript-eslint, Volar-based tools) cannot be adopted until 7.1.
