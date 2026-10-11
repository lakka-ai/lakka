# 0013. Run api and worker TypeScript directly on Node 24

Status: accepted

## Context

api and worker need to run TypeScript in development and in the image. Options: compile with tsc, bundle, use a loader (tsx), or use Node's built-in type stripping, which is stable since Node 24.12.

## Decision

api, worker and the web production server run `.ts` files directly with Node's type stripping, in development (`node --watch`) and in production. There is no build step for them; web is built by Vite. `tsconfig.base.json` sets `erasableSyntaxOnly`, `verbatimModuleSyntax` and `allowImportingTsExtensions`. Imports use explicit `.ts` extensions, and workspace packages export `./src/index.ts`.

## Consequences

- No bundler, transpiler or loader dependency, and stack traces point at real source lines.
- Enums, namespaces and constructor parameter properties are not allowed. We do not want them anyway.
- Node refuses to strip types under `node_modules`. Workspace packages work because Node resolves pnpm's symlinks to their real path; this is covered by the running stack.
