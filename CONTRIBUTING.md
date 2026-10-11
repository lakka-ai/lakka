# Contributing to Lakka

Thanks for helping. This page says how a change gets in. The rules behind it, for people and AI
tools alike, are in [`CLAUDE.md`](CLAUDE.md); read it before your first pull request.

To report a security problem, follow [`SECURITY.md`](SECURITY.md). Never open a public issue or
pull request for one.

## No CLA: the Developer Certificate of Origin

Lakka is licensed `AGPL-3.0-only` (ADR 0001), and so is every contribution: what you send is
licensed to everyone under the same terms as the rest of the code. There is no contributor license
agreement and nothing to assign. The project cannot relicense your work (ADR 0002).

Instead, every commit carries a sign-off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). By signing off, you
certify, in short, that you wrote the change or otherwise have the right to submit it under the
project's license, and that you understand the contribution and your sign-off are public and kept
for good. The linked text is the one that applies.

Sign off with `-s`:

```
git commit -s -m "fix(api): ..."
```

That adds a trailer with your name and email from `git config`:

```
Signed-off-by: Ada Lovelace <ada@example.com>
```

- The email in the sign-off must be the commit's author email. Use a name you are known by.
- To sign off commits you have already made on a branch: `git rebase --signoff main`, then push
  again.
- If a tool helped you write the change, you still sign off, and your sign-off covers all of it.
- `pnpm check:dco` checks your branch; the `dco` job checks every pull request.

## Before you start

- **Small fixes**, such as a typo, a broken link or an obvious bug: open a pull request.
- **Anything larger**: open an issue first, so we can agree on the approach before you write it.
  Changes start from the specifications (`docs/requirements.md`, `docs/tech-spec.md`) and the
  decisions in `docs/decisions/`. Where code and spec disagree, say so in the issue rather than
  picking one.
- **Scope**: `docs/roadmap.md` lists what is planned. Some things wait for v2, and some are out of
  scope for good; `CLAUDE.md` names both.
- **Dependencies**: ask before adding a runtime dependency, with what it does, why the current
  stack cannot do it, its license and how well it is maintained. Licenses must be compatible with
  the AGPL (`CLAUDE.md`, Dependencies).

## Making a change

- Set up as the README's Develop section says: Node 24, pnpm and Docker, then `pnpm install` and
  `pnpm dev`.
- One logical change per commit, written as a
  [Conventional Commit](https://www.conventionalcommits.org/) (`feat(core): ...`), with the
  requirement IDs it touches in the body.
- Every requirement you implement gets a test whose name includes its ID, such as
  `BG-3: concurrent reservations never exceed the cap`.
- Never skip, weaken or delete a failing test to get green. If a test is wrong, say why in the
  pull request.
- A decision the docs do not cover gets a short ADR in `docs/decisions/`: context, decision and
  consequences.
- Web UI changes follow the approved design in `docs/design/HANDOFF.md`.

## Before you open the pull request

Run, and report the results in the pull request:

```
pnpm typecheck && pnpm lint && pnpm test
pnpm format:check && pnpm check:copy
pnpm test:integration    # if you touched packages/core, packages/db or budgets
pnpm test:stories        # if you touched apps/web
pnpm check:dco
```

`pnpm ci:local` runs every CI job from a clean clone of your current commit, if you want the
whole set.

The pull request template asks for the requirement IDs, the checks you ran and the rules above.
A maintainer reviews every change; CI must pass, the `dco` job included.
