# 0037. Model catalogue and custom models

Status: accepted; the feed it deferred is built by ADR 0116, which puts models only the feed lists after custom models; ADR 0126 adds five providers and Qwen's price brackets.

## Context

PR-5 requires a model catalogue with per-token prices that works fully offline. PR-7 lets an admin add a model the catalogue does not know, with prices entered by hand. BG-4 refuses a model with no known price. ADR 0019 makes money integer micro-USD, and noted that per-token prices below one micro-USD need care. The tech spec's `model_pricing.effective_from` keeps price history so old usage is priced at the rate that applied, and leans towards copying the price into each usage row instead. The M2 plan settled these as D2, D3 and D13.

## Decision

- **The catalogue is a committed file**, `packages/core/catalogue/models.json`, shipped in the image and validated with zod at startup. The api refuses to start with an invalid one. Nothing is fetched at runtime (NF-D5).
- **The update script:** `pnpm catalogue:update` (development only) regenerates the file from LiteLLM's price list (MIT) at a pinned commit, recorded in the file.
  - The filter is a rule, not a hand-kept list. It keeps chat models from Anthropic, OpenAI and Google that have input and output prices above zero and known context and output limits. It drops deprecated models, fine-tunes, and audio, realtime, search, image and robotics variants. For OpenAI it keeps only models the Responses API serves (ADR 0036).
  - A zero price in the source means unknown, so such models are left out rather than served as free.
  - The diff is reviewed in the PR, because it changes what requests are billed.
- **Prices are integer micro-USD per million tokens.** $3 per million tokens is 3,000,000 and $0.075 is 75,000.
  - Conversion from the source's dollars per token must be exact, or the script fails.
  - Cache-read and cache-write prices are nullable. Null means unknown, and cost accounting then bills those tokens at the input price, the pessimistic choice.
- **Long-context tiers are kept.** A tier is a set of prices that applies to the whole request once its input exceeds a size (above 200k tokens for Anthropic and Google, above 272k for OpenAI), matching how those providers bill. Tiers only ever raise prices; a test checks this.
- **No price history table.** Each usage row copies the price it used, so a later catalogue update never re-prices old spend. The catalogue lives in memory; custom models live in Postgres.
- **Model references are `provider:model`.** The provider is a first-party kind (`anthropic`, `openai`, `google`) or the name of an OpenAI-compatible endpoint. The model is the provider's own id and may contain colons, as Ollama tags do (`ollama:llama3.3:70b`).
- **Custom models:**
  - Only instance admins add, change or remove them, through the api and the Models admin page. Keys and workspace admins cannot, even an instance admin's key. Whoever sets a price decides what budgets are charged, so a workspace admin who could set prices could make their spend uncapped.
  - A custom model can never take a catalogue model's id.
  - Price 0 is allowed but must be entered, for models on the customer's own hardware.
  - Custom models have no tiers.
- **Resolution order:** catalogue first, then custom models. A model in neither is refused with `unknown_model` (BG-4).

## Consequences

- The catalogue lists 111 models at the first generation. Updating prices is a reviewed code change and ships with a release. The signed refresh feed (PR-6, a SHOULD) is deferred to M7.
- **Prices not modelled:** OpenAI's priority and flex tiers, batch prices, regional-processing uplifts such as EU data residency, and Anthropic's one-hour cache writes. The gateway uses standard processing and default caching, so these do not arise from our own requests. A customer on a regional endpoint would be undercharged by the uplift; a per-credential price multiplier can address that later.
- Adding the Models page gave instance admins a place to check exactly what will be billed.
