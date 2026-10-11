# 0007. Enforcing the core import boundary

Status: accepted

## Context

`packages/core` must not import fastify, react, `@tanstack/*` or any `apps/*` package (CLAUDE.md, API-3). The rule needs enforcement, not a comment.

## Decision

Two checks:

- oxlint `no-restricted-imports` overrides for `packages/core/**` (and for `apps/web/**`) in `.oxlintrc.json`, covering static, type-only and dynamic imports. These give feedback in the editor and in `pnpm lint`.
- `test/boundaries.test.ts`, run by `pnpm test`, checks each package's `package.json` dependencies and scans source imports, including relative imports that leave the package. It covers core, db, contracts and web.

## Consequences

- A forbidden import fails both `pnpm lint` and `pnpm test`.
- The test scans with regular expressions rather than parsing TypeScript. It has a self-test for the import forms it relies on.
