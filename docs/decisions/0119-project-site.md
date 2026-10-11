# 0119. The project site: VitePress 2, the guide read in place, nothing from a third party

Status: accepted. Scope: M9 (docs/roadmap.md).

## Context

- Lakka needs a public website: a short landing page and the operator guide, which lives in
  `docs/guide/` and is read on GitHub today. The specs, ADRs, design docs and gates stay in the
  repository.
- The guide is a release gate (docs/roadmap.md, Documentation as a release gate). A second copy
  for the site would drift from it.
- Invariant 8 keeps the product from sending anything anywhere by default. A site about that
  product that loads fonts from a font service or counts its visitors would contradict it.
- The site should look like the app: the Spruce theme (ADR 0101), its typefaces, and the
  accessibility rules the app is held to.
- VitePress 1.6.4, the stable line, builds on Vite 5; `apps/web` is on Vite 8, which VitePress
  2's alphas use. A static site has a small blast radius if an alpha misbehaves.

## Decision

- **Generator: VitePress 2, pinned exactly** (`2.0.0-alpha.20`, MIT), in a workspace package,
  `apps/site` (`@lakka/site`, private, development dependencies only). The default theme is
  changed only through its CSS variables and a short stylesheet: no custom layout, no forked
  components, no Vue components of our own.
- **The guide is read in place.** VitePress's source directory is the repository's `docs/`
  (`srcDir: '../../docs'`); everything except `docs/index.md`, the landing page, and
  `docs/guide/` is excluded. `guide/README.md` is served as `/guide/`. A page that renders badly
  is fixed in `docs/guide/`, keeping its GitHub rendering right, or with CSS.
- **Nothing leaves the visitor's browser for a third party.** Search is VitePress's local search,
  an index built with the site. Fonts come from the same OFL `@fontsource` packages the app uses,
  bundled into the build, and the theme is `vitepress/theme-without-fonts`, so VitePress's own
  Inter is not loaded. No analytics, no external scripts, images or frames. Links out are fine.
- **Theme by variables.** The site imports `docs/design/theme/lakka-theme.css` itself and maps
  its tokens onto VitePress's `--vp-*` variables. VitePress puts `.dark` on `<html>`, which the
  theme file already defines, so one mapping serves light and dark. Code is plain text in the
  code block colours (Shiki's `none` theme), as the app draws it: highlighting themes bring
  colours never checked against the tokens.
- **Hosting: GitHub Pages**, deployed by `.github/workflows/pages.yml` with the official Pages
  actions, pinned by SHA. The base path is `LAKKA_SITE_BASE` at build time, `/lakka/`
  by default; the workflow takes it from Pages itself, so a custom domain needs no change here.
- **Checks.** `pnpm site:check` builds the site, which fails on a dead link; checks that every
  anchor resolves both on the site and on GitHub, that nothing in the build loads from another
  host, and that the fonts are there; then, in Chromium, WebKit and Firefox, checks every page
  the site builds at ten sizes from 320px to 2560px in light and dark (axe, no console errors, no
  sideways scrolling, no request to another host, 44px targets below 1024px), each menu, the
  sidebar and search open at each size, and the site with a keyboard alone. It runs in the CI
  `site` job, one engine to a leg.

Three details the brief did not settle:

- **Vue stays out of the product's dependencies.** better-auth lists `vue` as an optional peer,
  and pnpm links an optional peer to any version found anywhere in the workspace, so adding the
  site would have installed Vue into the product image. An override in `pnpm-workspace.yaml`
  gives that peer a range no release satisfies. pnpm 12.6 turns the documented `'-'` (remove)
  into `'*'` for a peer, which still links it. `docker/Dockerfile` is unchanged, and
  `.dockerignore` keeps `apps/site` out of the build context.
- **Vue is aliased for pages outside the package.** Pages compiled from `docs/` import `vue`,
  which pnpm installs only under `apps/site`. The site config points those imports at the
  package's own copy, the one VitePress uses. No copy step, no hoisting.
- **Localhost links are not dead links.** The guide links `http://localhost:8080`, the reader's own
  install. The build ignores localhost links only (`ignoreDeadLinks: 'localhostLinks'`); any other
  dead link fails it.

## Consequences

- One source: a change to the guide changes the site on the next deploy, and the GitHub view
  stays right because nothing site-only is written into the Markdown.
- Placeholders in the guide such as `<name>` are written `\<name>`. Unescaped, both GitHub and
  VitePress read them as HTML tags: GitHub dropped them, and VitePress's Vue compiler refused
  the page.
- VitePress 2 is an alpha. Upgrading it is a reviewed change like any other; if an alpha blocks
  the site, the fallback is the stable 1.x line on its own Vite, not another generator.
- The site deploys only once GitHub Actions is available (ADR 0086) and Pages is enabled for
  the repository.
- The product is untouched: no change to `apps/api`, `apps/web`, `apps/worker`, `packages/*` or
  the image.
