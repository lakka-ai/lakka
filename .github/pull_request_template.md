## What and why

<!-- What this changes and why. Name the requirement IDs it implements or touches (BG-3, TL-4,
NF-S5, ...) and the ADRs it follows or adds. Link the issue it closes. -->

## How it was checked

<!-- The commands you ran and their results. If something still fails, say which and why. -->

- [ ] `pnpm typecheck && pnpm lint && pnpm test`
- [ ] `pnpm test:integration`, if this touches `packages/core`, `packages/db` or budgets
- [ ] `pnpm format:check` and `pnpm check:copy`
- [ ] `pnpm test:stories`, if this touches `apps/web`

## The rules in CLAUDE.md

- [ ] Every new or changed requirement has a test whose name includes its ID.
- [ ] No test was skipped, weakened or deleted to get green.
- [ ] The invariants still hold: one policy path, keys as delegations, budgets that fail closed,
      no telemetry, no secrets or content in logs.
- [ ] No new runtime dependency, or it was agreed first, with its license.
- [ ] A decision the docs do not cover has an ADR in `docs/decisions/`.
- [ ] Commits follow Conventional Commits, one logical change each, with requirement IDs in the
      body.
- [ ] Every commit is signed off (`git commit -s`, the DCO in CONTRIBUTING.md).
