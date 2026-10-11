# 0001. License: AGPL-3.0-only

Status: accepted

## Context

The requirements fix AGPL v3 for all code but not whether later versions of the license may apply. The SPDX identifier goes into every package manifest.

## Decision

All code is licensed `AGPL-3.0-only`. `LICENSE` holds the official text from gnu.org, and every `package.json` sets `"license": "AGPL-3.0-only"`.

## Consequences

- We keep control over license terms: a future AGPLv4 does not apply automatically.
- Moving to a later version would need agreement from every copyright holder, or a CLA. The roadmap rules out relicensing the hosted edition, so this is unlikely to matter.
- Dependency license checks continue to use the allowed list in `CLAUDE.md`.
