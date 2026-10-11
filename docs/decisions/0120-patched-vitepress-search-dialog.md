# 0120. A patch to VitePress for the search dialog's roles

Status: accepted. Scope: the project site (ADR 0119).

## Context

The project site's search is VitePress's local search (ADR 0119). Opened, its dialog failed axe
(`nested-interactive`, serious) at every width, in two places, in VitePress 2.0.0-alpha.20, the
latest release, and from 768px in a third (`aria-prohibited-attr`, serious):

- The dialog's outer element is `role="button"`, with `aria-haspopup="listbox"`,
  `aria-expanded` and `aria-owns` on the results. The search field, its buttons and every result
  sit inside a button, and nothing says a dialog is open.
- Each result is an `<li role="option">` around an `<a>`: an option with a link inside it.
- The keyboard hints under the results, shown from 768px, name each key with `aria-label` on a
  `<kbd>`, which has no role that allows a label; the arrow and Enter keys hold only an icon, so
  their names may never be read.

The site's checks had searched but never run axe on the open dialog, so none was seen until
search was checked on a phone and then a tablet. CSS cannot change roles; ADR 0119 rules out
forking VitePress's components or adding Vue components of our own. The repository already
patches a dependency for an accessibility fault that upstream has not fixed (ADR 0103).

## Decision

- **Patch VitePress** with pnpm (`patches/vitepress@2.0.0-alpha.20.patch`, listed under
  `patchedDependencies` in `pnpm-workspace.yaml`), changing `VPLocalSearchBox.vue`'s markup and,
  for focus, one option of its script, never its styles:
  - the outer element is `role="dialog"` with `aria-modal="true"`, keeping its
    `aria-labelledby`; the button's `aria-haspopup`, `aria-expanded` and `aria-owns` go;
  - each `<li>` is `role="none"`, and its `<a>` takes `role="option"`, the id the field's
    `aria-activedescendant` names, and `aria-selected`. HTML allows `role="option"` on a link.
    Class names are unchanged, so VitePress's script and the site's CSS still find the results.
  - each key in the hints keeps its icon or "esc", hidden from screen readers, and carries its
    name as visually hidden text, with VitePress's own `visually-hidden` class.
  - closing the dialog gives focus back to what had it when the dialog opened, the search button
    as a rule (WCAG 2.4.3). VitePress's focus trap returned it nowhere, leaving focus on the
    page's body, as the site's keyboard checks found. The patch passes the trap a
    `setReturnFocus` naming that element while it is still in the page.
- **Test it.** `test/site/every-state.spec.ts` runs axe on the open dialog at every size the
  site is checked at, 320px to 2560px, in light and dark, in the list and the detailed view, with
  no rule turned off, in Chromium, WebKit and Firefox; `test/site/site.spec.ts` checks that the
  dialog is a dialog, that the field names an option marked selected, and that the arrow keys,
  Enter and a tap open a result; `test/site/keyboard.spec.ts` that Escape closes it and gives
  focus back to the search button.
- **Delete the patch** when VitePress fixes all four upstream, or when the version it targets is
  upgraded; pnpm refuses to install a patch that no longer applies.

## Consequences

- pnpm reads every listed patch file before it installs, whether or not the package is installed,
  so the product image's build needs the file too. The Dockerfile copies `patches/` whole, and
  the image gains one inert text file, `/app/patches/vitepress@2.0.0-alpha.20.patch` (about
  4 KB), beside react-aria's. Nothing reads it at runtime and the image's size is unchanged.
  The project owner accepted this over a Dockerfile change, which the M9 brief
  keeps out of scope.
- The fix should be offered upstream; until it lands, each VitePress upgrade rebuilds the patch.
