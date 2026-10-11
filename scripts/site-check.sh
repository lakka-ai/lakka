#!/usr/bin/env bash
# The project site's checks (ADR 0119): build it, which fails on a dead link; check the built
# pages' anchors, that nothing loads from another host, and that the fonts are there; then check
# every page in Chromium, WebKit and Firefox, at ten sizes from a 320px phone to a 2560px desktop,
# in light and dark, with axe; what the pages do when opened: menus, search, the sidebar; and the
# site with a keyboard alone.
# Usage: scripts/site-check.sh [playwright options]   e.g. --project=webkit for one engine
#        (LAKKA_SITE_BASE as for the build)
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm site:build
node scripts/site-check.ts
pnpm exec playwright test --config playwright.site.config.ts "$@"
