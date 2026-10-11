# 0126. DeepSeek, Moonshot AI, Qwen Cloud, Xiaomi MiMo and Z.ai as first-party providers

Status: accepted; extends ADR 0036 (provider adapter), ADR 0037 (model catalogue) and ADR 0038 (provider credentials). The catalogue moved to LiteLLM main (7ff50106) in the next change, which dropped the retired DeepSeek models and Claude Sonnet 4.5's retired 1M context.

## Context

- PR-4 asks for at least Anthropic, OpenAI, Google and any OpenAI-compatible endpoint. The owner asked for five more hosted providers in the bundled catalogue, named as LiteLLM names them, our price source: `deepseek`, `moonshot`, `qwencloud`, `xiaomi_mimo` and `zai`.
- A catalogue model is only useful if a provider connection serves it. Before this, a connection was one of the three first-party kinds or an OpenAI-compatible endpoint whose name and address an admin typed. Catalogue entries for `deepseek:*` would have been priced but callable only through an endpoint someone happened to name `deepseek`, and the signed feed refuses any provider that is not first-party (ADR 0116).
- All five speak OpenAI chat completions, stream usage when `stream_options.include_usage` is set, send reasoning as `reasoning_content`, and answer `GET /models` with 401 without a key.
- This sits outside M10 (routing accuracy); the owner approved it as a separate change.

## Decision

- **Five new first-party kinds**, `deepseek`, `moonshot`, `qwencloud`, `xiaomi-mimo` and `zai`, listed once in `contracts` (`COMPATIBLE_FIRST_PARTY_KINDS`) and part of `FIRST_PARTY_KINDS`. Our provider names allow no underscore, so LiteLLM's `xiaomi_mimo` is `xiaomi-mimo`.
  - Like Anthropic, OpenAI and Google, each is named by its kind, needs a key, has a row on the Model providers page, can be keyed per workspace at its standard address only (ADR 0038), and is trusted by the signed feed.
  - Their names are reserved: an OpenAI-compatible endpoint cannot take one.
  - The Postgres checks on `provider_configs` are built from the same constants, so the schema and contracts cannot drift. Migration 0039 widens them. It converts nothing: no install has data yet.
- **No new dependency.** Each goes through `@ai-sdk/openai-compatible` (ADR 0036) with its key required and usage on the stream, at a fixed default address:
  - DeepSeek `https://api.deepseek.com`
  - Moonshot AI `https://api.moonshot.ai/v1`
  - Qwen Cloud `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, Alibaba Cloud Model Studio in Singapore, as LiteLLM's `qwencloud` uses
  - Xiaomi MiMo `https://api.xiaomimimo.com/v1`
  - Z.ai `https://api.z.ai/api/paas/v4`

  The dedicated AI SDK packages for some of them would add dependencies for nothing these providers need. Mainland China regions have other addresses and prices; an admin adds one as an OpenAI-compatible endpoint under its own name, with custom models.

- **Spans** use the conventions' `deepseek` for DeepSeek; the conventions name none of the others, so they carry their own name, as compatible endpoints do.
- **The update script** maps the five LiteLLM providers by the existing rule (chat, priced, known limits, not deprecated) and adds:
  - **Keys that carry their provider**, such as `deepseek/deepseek-chat`, lose the prefix, so they merge with the bare key, as `gemini/` did.
  - **Price brackets.** Qwen prices many models by input size, each bracket for the whole request (`tiered_pricing`). That is our long-context tier: the first bracket is the base price and each later one a tier above where it starts. Brackets must start at zero and meet end to end, and an entry cannot have both a flat price and brackets, or the script fails.
  - **Reasoning priced apart is left out.** Some Qwen models bill reasoning tokens above other output (`qwen-turbo`, newer `qwen-plus` versions: $4 against $1.20 per million). Usage counts reasoning as output, so they would be undercharged and a cap could be overspent (BG-4). The rule drops any model with a reasoning price different from its output price, in any bracket. The guide says so, and an admin can add one as a custom model at its reasoning rate.
  - **A zero cache price is unknown**, like a zero input or output price: it becomes null, and those tokens are billed as input. DeepSeek and Z.ai list cache writes at 0. The compatible adapter never reports cache writes, so this changes no bill today; it keeps a future one from being free by accident.
- **The catalogue is regenerated at the LiteLLM commit already pinned.** That commit has all five providers, and staying on it keeps the existing Anthropic, OpenAI and Google entries unchanged; two of them drop out because their deprecation date has since passed. Moving to a newer commit is a separate change.
- **Display names** know GLM, MiMo, QwQ and VL, read `a3b` as A3B (active parameters), and drop a dashed date as they drop an eight-digit one.

## Consequences

- The catalogue grows from 111 to 178 models: DeepSeek 10, Moonshot AI 11, Qwen Cloud 32, Xiaomi MiMo 2, Z.ai 14.
- **Prices not modelled:**
  - DeepSeek's off-peak discount: those requests are charged the standard price, the pessimistic side.
  - Audio and video input, which MiMo and Kimi accept: our attachments are images, PDFs and text only (ADR 0058), so no such tokens are sent.
- A provider that stops reporting `prompt_tokens_details.cached_tokens` has its cache reads billed at the input price. DeepSeek reports it; a fixture test pins its usage shape.
- At the pinned commit LiteLLM still lists some DeepSeek models DeepSeek has since retired, such as `deepseek-chat` and `deepseek-reasoner`. They stayed until the next catalogue update moved the commit, which dropped them.
- Adding a provider of this shape again means one entry in `COMPATIBLE_FIRST_PARTY_KINDS`, its address, its label, a line in the update script and a migration for the checks.
