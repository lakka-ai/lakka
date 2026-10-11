import { z } from 'zod';

/*
 * The model catalogue (PR-5, PR-7, ADR 0037). Prices are integer micro-USD per million tokens:
 * $3 per million input tokens is 3_000_000, and $0.075 is 75_000. Integers keep budget
 * arithmetic exact (ADR 0019), and per-million units keep cheap models above one micro-USD.
 *
 * A model reference is "<provider>:<model>": the provider is a first-party provider kind or the
 * name of an OpenAI-compatible endpoint, and the model is the provider's own id, which may itself
 * contain colons (Ollama tags such as llama3.3:70b).
 */

export const PROVIDER_NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const providerNamespace = z.string().regex(PROVIDER_NAMESPACE_PATTERN);
export const providerModelId = z.string().regex(/^[^\s:][^\s]{0,199}$/);
export const modelRef = z
  .string()
  .max(241)
  .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?:[^\s:][^\s]*$/);

export function parseModelRef(ref: string): { provider: string; model: string } | undefined {
  if (!modelRef.safeParse(ref).success) return undefined;
  const colon = ref.indexOf(':');
  return { provider: ref.slice(0, colon), model: ref.slice(colon + 1) };
}

const price = z.int().min(0).max(10_000_000_000);

export const modelPrices = z
  .object({
    inputMicroUsdPerMtok: price,
    outputMicroUsdPerMtok: price,
    /** Null when the provider has no cache pricing; cache reads are then billed as input. */
    cacheReadMicroUsdPerMtok: price.nullable(),
    /** Null when unknown; cache writes are then billed as input. */
    cacheWriteMicroUsdPerMtok: price.nullable(),
  })
  .strict();
export type ModelPrices = z.infer<typeof modelPrices>;

/**
 * One price per million tokens to compare models by, weighted for chat traffic, which reads
 * about three input tokens per output token (RT-5, E4). Used to tell whether a route moves a
 * request to a cheaper model, and which way users override.
 */
export function blendedPrice(prices: ModelPrices): number {
  return (3 * prices.inputMicroUsdPerMtok + prices.outputMicroUsdPerMtok) / 4;
}

/**
 * A higher price that applies to the whole request once its input exceeds a size, as Anthropic,
 * Google and OpenAI charge for long contexts.
 */
export const priceTier = z
  .object({ aboveInputTokens: z.int().positive(), prices: modelPrices })
  .strict();
export type PriceTier = z.infer<typeof priceTier>;

export const modelCapabilities = z
  .object({
    vision: z.boolean(),
    pdf: z.boolean(),
    tools: z.boolean(),
    structuredOutput: z.boolean(),
    promptCaching: z.boolean(),
    reasoning: z.boolean(),
  })
  .strict();
export type ModelCapabilities = z.infer<typeof modelCapabilities>;

export const catalogueModel = z
  .object({
    id: modelRef,
    provider: providerNamespace,
    model: providerModelId,
    contextWindow: z.int().positive(),
    maxOutputTokens: z.int().positive(),
    capabilities: modelCapabilities,
    prices: modelPrices,
    tiers: z.array(priceTier),
  })
  .strict()
  .refine((m) => m.id === `${m.provider}:${m.model}`, 'id must be provider:model');
export type CatalogueModel = z.infer<typeof catalogueModel>;

export const catalogueFile = z
  .object({
    /**
     * Goes up by one each time the file is regenerated. A signed feed applies only with a
     * higher serial than the bundled file's and the last feed applied (PR-6, ADR 0116).
     */
    serial: z.int().min(1),
    source: z.string(),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    license: z.string(),
    generatedAt: z.iso.date(),
    models: z.array(catalogueModel).min(1),
  })
  .strict();
export type CatalogueFile = z.infer<typeof catalogueFile>;

/*
 * A model's name for people, from its provider id: claude-sonnet-4-5 -> "Claude Sonnet 4.5",
 * gpt-4.1-mini -> "GPT-4.1 mini", llama3.3:70b -> "Llama 3.3 70B". The catalogue has no names
 * of its own, so they are made here; a custom model can set one instead.
 */
const BRANDS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  gpt: 'GPT',
  llama: 'Llama',
  gemini: 'Gemini',
  gemma: 'Gemma',
  mistral: 'Mistral',
  mixtral: 'Mixtral',
  qwen: 'Qwen',
  qwq: 'QwQ',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  mimo: 'MiMo',
  vl: 'VL',
  phi: 'Phi',
  command: 'Command',
};
const LOWER = new Set(['mini', 'nano', 'turbo', 'instruct', 'preview']);

export function modelDisplayName(model: string): string {
  const tokens = model
    .replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '')
    .split(/[-_:/\s]+/)
    // llama3.3 is Llama 3.3; o3 stays o3.
    .flatMap((token) => token.split(/(?<=[a-z]{2})(?=\d)/i))
    .filter((token) => token !== '');
  // Version numbers written as separate parts: claude-sonnet-4-5 is 4.5.
  const merged: string[] = [];
  for (const token of tokens) {
    const last = merged.at(-1);
    if (/^\d+$/.test(token) && last !== undefined && /^\d+$/.test(last)) {
      merged[merged.length - 1] = `${last}.${token}`;
    } else {
      merged.push(token);
    }
  }
  const words: string[] = [];
  for (const token of merged) {
    const lower = token.toLowerCase();
    const brand = BRANDS[lower];
    if (words.at(-1) === 'GPT' && /^\d/.test(token)) {
      words[words.length - 1] = `GPT-${lower}`;
    } else if (brand !== undefined) {
      words.push(brand);
    } else if (/^a?\d+(\.\d+)?[bmk]$/i.test(token)) {
      // Sizes, and active parameters of a mixture of experts: 80b-a3b is 80B A3B.
      words.push(token.toUpperCase());
    } else if (/^\d/.test(token) || LOWER.has(lower) || /^o\d/.test(lower)) {
      words.push(lower);
    } else {
      words.push(lower.slice(0, 1).toUpperCase() + lower.slice(1));
    }
  }
  return words.join(' ');
}

const displayName = z.string().trim().min(1).max(80);

/** A model an instance admin added by hand, with prices they entered (PR-7). */
export const customModelBody = z
  .object({
    provider: providerNamespace,
    model: providerModelId,
    /** The name people see; made from the model id when absent. */
    displayName: displayName.optional(),
    contextWindow: z.int().positive().max(100_000_000),
    maxOutputTokens: z.int().positive().max(10_000_000),
    capabilities: modelCapabilities,
    prices: modelPrices,
  })
  .strict();
export type CustomModelBody = z.infer<typeof customModelBody>;

export const customModelParams = z.object({ customModelId: z.uuid() });

export interface ModelView {
  id: string;
  provider: string;
  model: string;
  /** The name people see: the custom model's own, or one made from the id. */
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  prices: ModelPrices;
  tiers: PriceTier[];
  source: 'catalogue' | 'custom';
  /** Custom models only: the row to edit or delete. */
  customModelId: string | null;
  /**
   * True when the price comes from the signed price feed and differs from this release's, or the
   * model is one only the feed lists (PR-6, ADR 0116).
   */
  priceUpdated: boolean;
}

/** Which kinds of file a choice can read (CH-5): images need vision, PDFs need PDF support. */
export interface InputSupport {
  images: boolean;
  pdf: boolean;
}

/**
 * What a caller may ask for in a workspace, as /v1/models lists it, with the files each choice
 * can read (CH-5, ADR 0062). For a route, any of its models; for "auto", any model it could pick.
 */
export interface RequestableView {
  auto: InputSupport;
  /** Each enabled route with the model it sends to first, for the model picker (CH-3). */
  routes: { name: string; model: string; modelName: string; input: InputSupport }[];
  models: { id: string; displayName: string; input: InputSupport }[];
  /**
   * How the workspace picks a model, so chat can say it (CH-2, RT-11): with routing off there
   * is no Auto, and a pinned model answers unless the person picks another one (RT-3).
   */
  routing: {
    enabled: boolean;
    defaultModel: { id: string; name: string } | null;
    pinnedModel: { id: string; name: string } | null;
  };
}
