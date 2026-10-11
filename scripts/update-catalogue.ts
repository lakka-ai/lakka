import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogueFile } from '../packages/contracts/src/models.ts';
import type { FirstPartyKind } from '../packages/contracts/src/providers.ts';
import type {
  CatalogueFile,
  CatalogueModel,
  ModelPrices,
  PriceTier,
} from '../packages/contracts/src/models.ts';

/*
 * Regenerates the bundled model catalogue (PR-5, ADR 0037) from LiteLLM's price list (MIT).
 * Development only: the image ships the committed file and never fetches anything (NF-D5).
 * Review the diff before committing; it changes what every request is billed. Each run raises
 * the serial by one, so a signed price feed made from the new file supersedes the old one
 * (PR-6, ADR 0116); `pnpm catalogue:sign` makes that feed.
 *
 * Usage: node scripts/update-catalogue.ts [litellm-commit]   (default: the tip of main)
 */

const REPO = 'BerriAI/litellm';
const FILE = 'model_prices_and_context_window.json';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'packages', 'core', 'catalogue', 'models.json');

/** LiteLLM provider name to our provider kind. */
const PROVIDERS: Record<string, FirstPartyKind> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  deepseek: 'deepseek',
  moonshot: 'moonshot',
  qwencloud: 'qwencloud',
  // Our provider names have no underscores.
  xiaomi_mimo: 'xiaomi-mimo',
  zai: 'zai',
};

/** Not general text chat, or not reachable through the interface we use. */
const EXCLUDED = [
  /^ft:/,
  /audio/,
  /realtime/,
  /search/,
  /tts/,
  /computer-use/,
  /deep-research/,
  /robotics/,
  /lyria/,
  /image/,
  /^gemma/,
  /container/,
];

interface Entry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  deprecation_date?: string;
  supported_endpoints?: string[];
  supports_vision?: boolean;
  supports_pdf_input?: boolean;
  supports_function_calling?: boolean;
  supports_response_schema?: boolean;
  supports_prompt_caching?: boolean;
  supports_reasoning?: boolean;
  /** Prices by input size, each for the whole request, as Qwen bills. Ranges are in tokens. */
  tiered_pricing?: Bracket[];
  [key: string]: unknown;
}

interface Bracket {
  range: [number, number];
  [key: string]: unknown;
}

/** USD per token to integer micro-USD per million tokens, refusing anything inexact. */
function microUsdPerMtok(usdPerToken: number, where: string): number {
  const scaled = usdPerToken * 1e12;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-3) throw new Error(`${where}: ${usdPerToken} is not exact`);
  return rounded;
}

function prices(entry: Entry, suffix: string, where: string): ModelPrices | undefined {
  const at = (key: string) => {
    const value = entry[`${key}${suffix}`];
    return typeof value === 'number' ? microUsdPerMtok(value, `${where} ${key}${suffix}`) : null;
  };
  const input = at('input_cost_per_token');
  const output = at('output_cost_per_token');
  if (input === null || output === null) return undefined;
  // A zero cache price is unknown too: such tokens are then billed as input, never as free.
  const cache = (key: string) => {
    const value = at(key);
    return value === 0 ? null : value;
  };
  return {
    inputMicroUsdPerMtok: input,
    outputMicroUsdPerMtok: output,
    cacheReadMicroUsdPerMtok: cache('cache_read_input_token_cost'),
    cacheWriteMicroUsdPerMtok: cache('cache_creation_input_token_cost'),
  };
}

/** A tier keeps the base cache prices where it leaves them out. */
function withBaseCache(tierPrices: ModelPrices, base: ModelPrices): ModelPrices {
  return {
    ...tierPrices,
    cacheReadMicroUsdPerMtok: tierPrices.cacheReadMicroUsdPerMtok ?? base.cacheReadMicroUsdPerMtok,
    cacheWriteMicroUsdPerMtok:
      tierPrices.cacheWriteMicroUsdPerMtok ?? base.cacheWriteMicroUsdPerMtok,
  };
}

/**
 * Brackets that start at zero and meet end to end: the first is the base price, and each later
 * one is a tier above where it starts. Anything else is not a shape we can bill, and fails.
 */
function brackets(list: Bracket[], where: string): { base: ModelPrices; tiers: PriceTier[] } {
  const sorted = list.toSorted((a, b) => a.range[0] - b.range[0]);
  const priced = sorted.map((bracket, i) => {
    const previous = sorted[i - 1];
    const start = bracket.range[0];
    if (start !== (previous === undefined ? 0 : previous.range[1])) {
      throw new Error(`${where}: price brackets have a gap or overlap at ${start}`);
    }
    const bracketPrices = prices(bracket as Entry, '', `${where} bracket ${start}`);
    if (bracketPrices === undefined) throw new Error(`${where}: bracket ${start} has no price`);
    return { start, prices: bracketPrices };
  });
  const [first, ...rest] = priced;
  if (first === undefined) throw new Error(`${where}: no price brackets`);
  return {
    base: first.prices,
    tiers: rest.map((b) => ({
      aboveInputTokens: b.start,
      prices: withBaseCache(b.prices, first.prices),
    })),
  };
}

function tiers(entry: Entry, where: string): PriceTier[] {
  const thresholds = new Set<number>();
  for (const key of Object.keys(entry)) {
    const match = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
    if (match?.[1] !== undefined) thresholds.add(Number(match[1]) * 1000);
  }
  return [...thresholds]
    .toSorted((a, b) => a - b)
    .flatMap((threshold) => {
      const tierPrices = prices(entry, `_above_${threshold / 1000}k_tokens`, where);
      const base = prices(entry, '', where);
      if (tierPrices === undefined || base === undefined) return [];
      return [{ aboveInputTokens: threshold, prices: withBaseCache(tierPrices, base) }];
    });
}

/**
 * A separate price for reasoning tokens. Usage counts reasoning as output, so a model that bills
 * it above output would be undercharged; it is left out (BG-4).
 */
function reasoningApart(priced: Record<string, unknown>): boolean {
  return (
    priced['output_cost_per_reasoning_token'] !== undefined &&
    priced['output_cost_per_reasoning_token'] !== priced['output_cost_per_token']
  );
}

function pricesReasoningApart(entry: Entry): boolean {
  return reasoningApart(entry) || (entry.tiered_pricing ?? []).some(reasoningApart);
}

function toModel(key: string, entry: Entry, today: string): CatalogueModel | undefined {
  const litellmProvider = entry.litellm_provider ?? '';
  const provider = PROVIDERS[litellmProvider];
  if (provider === undefined) return undefined;
  if (entry.mode !== 'chat' && entry.mode !== 'responses') return undefined;
  // "gemini/gemini-flash-latest" and "deepseek/deepseek-chat" carry their provider in the key.
  const model = key.startsWith(`${litellmProvider}/`) ? key.slice(litellmProvider.length + 1) : key;
  if (EXCLUDED.some((re) => re.test(model))) return undefined;
  if (entry.deprecation_date !== undefined && entry.deprecation_date <= today) return undefined;
  // OpenAI models are called through the Responses API (ADR 0036).
  if (
    provider === 'openai' &&
    entry.supported_endpoints !== undefined &&
    !entry.supported_endpoints.includes('/v1/responses')
  ) {
    return undefined;
  }
  if (pricesReasoningApart(entry)) return undefined;
  const bracketed =
    entry.tiered_pricing === undefined ? undefined : brackets(entry.tiered_pricing, key);
  if (bracketed !== undefined && entry.input_cost_per_token !== undefined) {
    throw new Error(`${key}: both a flat price and price brackets`);
  }
  const base = bracketed?.base ?? prices(entry, '', key);
  // Zero means unknown in the source; a model is never listed as free by accident.
  if (base === undefined || base.inputMicroUsdPerMtok === 0 || base.outputMicroUsdPerMtok === 0) {
    return undefined;
  }
  if (entry.max_input_tokens === undefined || entry.max_output_tokens === undefined) {
    return undefined;
  }
  return {
    id: `${provider}:${model}`,
    provider,
    model,
    contextWindow: entry.max_input_tokens,
    maxOutputTokens: entry.max_output_tokens,
    capabilities: {
      vision: entry.supports_vision === true,
      pdf: entry.supports_pdf_input === true,
      tools: entry.supports_function_calling === true,
      structuredOutput: entry.supports_response_schema === true,
      promptCaching:
        entry.supports_prompt_caching === true || base.cacheReadMicroUsdPerMtok !== null,
      reasoning: entry.supports_reasoning === true,
    },
    prices: base,
    tiers: bracketed?.tiers ?? tiers(entry, key),
  };
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  const commit =
    requested === undefined
      ? await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
          headers: { accept: 'application/vnd.github.sha' },
        }).then((r) => r.text())
      : requested;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit sha: ${commit}`);
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${commit}/${FILE}`);
  if (!response.ok) throw new Error(`fetching ${FILE} failed: ${response.status}`);
  const source = (await response.json()) as Record<string, Entry>;

  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map<string, CatalogueModel>();
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const model = toModel(key, entry, today);
    // "deepseek-chat" and "deepseek/deepseek-chat" describe the same model.
    if (model !== undefined && !byId.has(model.id)) byId.set(model.id, model);
  }

  const previous = catalogueFile.parse(JSON.parse(readFileSync(outPath, 'utf8')) as unknown);
  const catalogue: CatalogueFile = catalogueFile.parse({
    serial: previous.serial + 1,
    source: `https://github.com/${REPO}/blob/${commit}/${FILE}`,
    sourceCommit: commit,
    license: 'MIT, (c) Berri AI; converted to micro-USD per million tokens',
    generatedAt: today,
    models: [...byId.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
  });
  writeFileSync(outPath, `${JSON.stringify(catalogue, null, 2)}\n`);
  const counts = Object.entries(
    Object.groupBy(catalogue.models, (m) => m.provider) as Record<string, CatalogueModel[]>,
  ).map(([p, ms]) => `${p} ${ms.length}`);
  process.stdout.write(
    `catalogue: serial ${catalogue.serial}, ${catalogue.models.length} models (${counts.join(', ')})\n`,
  );
}

await main();
