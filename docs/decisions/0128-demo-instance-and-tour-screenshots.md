# 0128. A demo instance for the tour's screenshots

Status: accepted.

## Context

- The owner asked for screenshots of Lakka in use for a tour page and for posts about the project, with the data to make them. A screenshot of an empty install shows nothing a reader cares about.
- `docs/design/docs/fixtures.md` already tells one story (Nordlys, its people, caps, keys and routes) that the mockups share. It used real-looking domains (nordlys.se, nordlys.fi) and models from 2025.
- The acceptance suite's fake provider (ADR 0061) answers "Hello there" to every model, so its chat and traces make empty screenshots, and changing it would put the suite at risk.
- Screenshots go stale whenever the UI changes. Pictures made by hand would not be remade.
- Caps, the spend report and the instance spend page need weeks of usage behind them. A demo cannot send tens of thousands of requests in reasonable time.

## Decision

- **A demo stack of its own**, `docker/compose.demo.yaml`, run as the compose project `lakka-demo` on port 8090, so it never touches a development or acceptance stack. It adds `test/demo/demo-provider.ts`, plain Node with no dependencies, which:
  - answers the Anthropic, OpenAI Responses and Google protocols with a scripted reply for each of the story's prompts, streamed word by word after a short first-token delay, with usage in proportion to the text;
  - serves a helpdesk MCP server with a read-only tool and one that asks first, for the approval story;
  - answers as the issuer of Nordlys SSO, so the sign-in provider can be registered. Nobody signs in through it.
- **The story is fixtures.md with two changes**: every address is under `nordlys.example`, a reserved name, and the models are current catalogue models (Claude Sonnet 5.5, Claude Haiku 5.5, Gemini 3.8 Flash, GPT-5 mini). Prices are the catalogue's.
- **`pnpm demo:seed` sets the stack up through the product.** It uses first-run setup, the operator CLI and the public API. Every request a screen shows on its own is real: chat, API calls with keys, the tool calls and the approval, the move to a cheaper model at the cap, and the refusal of a used-up key.
- **Spend history is the one exception.** It is written to Postgres directly: two months of `usage` rows aimed at fixed totals per person, workspace and key, then each cap's `budget_spend` recomputed from `usage`, then the worker restarted so Valkey's counters are rebuilt from Postgres (invariant 5). The same seed draws the same history. The seed also backdates memberships, last-active times and some conversations, and links the SSO people to Nordlys SSO.
- **`pnpm demo:capture` takes the pictures** with Playwright's Chromium:
  - every screen in light and dark, 1440 by 900 at twice the density, encoded as WebP by the browser's own canvas, so no image library is added;
  - a 1200 by 630 social card at `apps/site/public/og.png`;
  - a twelve-second WebM of the cheaper-model story for the tour.

  The browser maps `ai.nordlys.example` to the published port, so no screenshot shows a localhost address.

- **The tour says what is faked.** `docs/guide/tour.md` states that replies are scripted and the spend history was written to the database.
- **The site gets link-preview tags**: `og:*` and `twitter:card`, with each page's title and summary. The card's address is absolute, from `LAKKA_SITE_URL`, by default `https://lakka-ai.github.io/lakka/`.

## Consequences

- Remaking every picture after a UI change is three commands (`docs/guide/tour.md`, How these screenshots are made). Nothing checks that they are current; that stays a release-time chore.
- The images add about 4.6 MB to the repository, and each remake adds as much again to its history. The tour uses 14 screens; adding more costs about 300 KB each, light and dark.
- `test/demo` is development tooling, outside the product and the image, like the acceptance suite. Its direct writes to `usage` and `budget_spend` follow the schema as it is; a change to either table may need the seed to change with it.
- The seed needs a fresh stack and refuses one that is already set up.
- The demo found three UI defects, fixed in their own changes: code wider than a person's own message spilled out past the bubble's left edge (CH-1), a tool call waiting for approval was labelled "Used" in chat (TL-4), and a refused request's trace left the model's name out of its budget step (OB-1).
