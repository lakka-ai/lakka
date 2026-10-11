# 0103. A patch to React Aria for filtered list positions

Status: accepted.

## Context

The model picker (`apps/web/src/components/model-select.tsx`) is HeroUI's Autocomplete: a search
field over a list that builds only the rows in view, through React Aria's Virtualizer. Because
most rows are not in the page, React Aria gives each one `aria-posinset` and `aria-setsize`, so
screen readers can say "3 of 15".

Once a search narrows the list, the numbers disagree. Searching for "mistral" in a list of 15
leaves two options that read "14 of 2" and "15 of 2" (NF-A1, WCAG 1.3.1 and 4.1.2). The size
comes from the filtered collection; the position comes from each option's `index`, and React
Aria's `filterChildren` (`BaseCollection`) copies a kept node with the index it had before
filtering. This is the case in react-aria 3.52.1, the latest release, and on its main branch.

Filtering in the picker instead, and handing the list only the matches, gives correct numbers.
It also takes the chosen model out of the collection the field reads its value from, so while a
search hides it the field and its accessible name read "None".

## Decision

Patch react-aria with pnpm (`patches/react-aria@3.52.1.patch`, `patchedDependencies` in
`pnpm-workspace.yaml`). The patch numbers each kept node among the kept siblings in
`filterChildren`, as the collection does before filtering, in the three builds the package
ships. The picker is unchanged.

`test/stories/model-select.spec.ts` checks the numbers in a filtered picker, so an upgrade that
drops the patch without the fix fails the gallery tests.

## Consequences

- Every filtered React Aria collection gets correct positions, not just the model picker.
- The Docker image copies `patches/` before installing, or the install fails.
- pnpm refuses to install if the patch no longer applies, so upgrading react-aria means checking
  whether the new version fixes this. If it does, delete the patch and its entry; if not, make
  the patch again with `pnpm patch` for the new version.
- The bug is reported upstream as
  [adobe/react-spectrum#10711](https://github.com/adobe/react-spectrum/issues/10711). When a
  release fixes it, upgrade and delete the patch.
