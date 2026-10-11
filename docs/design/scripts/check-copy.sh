#!/usr/bin/env bash
# Moved to the repository's scripts/check-copy.sh, which also runs on macOS. Run it with
# `pnpm check:copy`.
exec "$(dirname "$0")/../../../scripts/check-copy.sh" "$@"
