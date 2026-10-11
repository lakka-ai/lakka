import {
  ForbiddenError,
  ModelExistsError,
  modelDisplayName,
  NotFoundError,
  parseModelRef,
  UnknownModelError,
} from '@lakka/contracts';
import type {
  CatalogueModel,
  CustomModelBody,
  ModelPrices,
  ModelView,
  Principal,
} from '@lakka/contracts';
import {
  deleteCustomModel,
  findCustomModelByRef,
  insertCustomModel,
  listCustomModels,
  updateCustomModel,
} from '@lakka/db';
import type { CustomModelRow, Db } from '@lakka/db';
import type { Catalogue, CatalogueStore } from './catalogue.ts';

/*
 * Which models exist and what they cost (PR-5, PR-7, ADR 0037). The bundled catalogue comes
 * first and a custom model can never take a bundled model's id. Models only a signed price feed
 * lists come last, so an admin's own price for a model wins over the feed's (PR-6, ADR 0116).
 * Only instance admins add or change custom models: prices decide what budgets are charged, so
 * whoever sets them can make spend uncapped, and that must not be a workspace admin or a key
 * (NF-S2).
 */

export interface ModelsContext {
  db: Db;
  catalogue: CatalogueStore;
}

function fromCatalogue(catalogue: Catalogue, model: CatalogueModel): ModelView {
  return {
    ...model,
    displayName: modelDisplayName(model.model),
    source: 'catalogue',
    customModelId: null,
    priceUpdated: catalogue.priceUpdated.has(model.id),
  };
}

function fromCustom(row: CustomModelRow): ModelView {
  return {
    id: row.modelRef,
    provider: row.provider,
    model: row.model,
    displayName: row.displayName ?? modelDisplayName(row.model),
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    capabilities: row.capabilities,
    prices: {
      inputMicroUsdPerMtok: row.inputMicroUsdPerMtok,
      outputMicroUsdPerMtok: row.outputMicroUsdPerMtok,
      cacheReadMicroUsdPerMtok: row.cacheReadMicroUsdPerMtok,
      cacheWriteMicroUsdPerMtok: row.cacheWriteMicroUsdPerMtok,
    },
    tiers: [],
    source: 'custom',
    customModelId: row.id,
    priceUpdated: false,
  };
}

export function mayManageModels(principal: Principal): boolean {
  return principal.kind === 'user' && principal.isInstanceAdmin;
}

function requireManager(principal: Principal): void {
  if (!mayManageModels(principal)) throw new ForbiddenError('only instance admins manage models');
}

/**
 * The model and its prices, for dispatch and cost accounting. A model that is not known has no
 * price and is refused (BG-4).
 */
export async function resolveModel(ctx: ModelsContext, ref: string): Promise<ModelView> {
  const catalogue = ctx.catalogue.current();
  const listed = catalogue.models.get(ref);
  if (listed !== undefined) return fromCatalogue(catalogue, listed);
  const custom = await findCustomModelByRef(ctx.db, ref);
  if (custom !== undefined) return fromCustom(custom);
  const fromFeed = catalogue.feedOnly.get(ref);
  if (fromFeed !== undefined) return fromCatalogue(catalogue, fromFeed);
  throw new UnknownModelError('this model is not in the catalogue and has no price');
}

/**
 * Names for people for the given model ids (CH-2): a custom model's own, else one made from the
 * id, also for a model no longer known, so old replies keep a readable name.
 */
export async function modelNames(
  ctx: ModelsContext,
  refs: Iterable<string>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const catalogue = ctx.catalogue.current();
  for (const ref of new Set(refs)) {
    const listed = catalogue.models.get(ref);
    if (listed !== undefined) {
      names.set(ref, modelDisplayName(listed.model));
      continue;
    }
    const custom = await findCustomModelByRef(ctx.db, ref);
    const model = catalogue.feedOnly.get(ref)?.model ?? parseModelRef(ref)?.model ?? ref;
    names.set(ref, custom?.displayName ?? modelDisplayName(model));
  }
  return names;
}

/** A model's base prices, or undefined for a model with no price (BG-4). */
export async function findModelPrices(
  ctx: ModelsContext,
  ref: string,
): Promise<ModelPrices | undefined> {
  try {
    return (await resolveModel(ctx, ref)).prices;
  } catch (error) {
    if (error instanceof UnknownModelError) return undefined;
    throw error;
  }
}

/**
 * Every model with a price: custom models first, then the catalogue, then models only the feed
 * lists that no custom model has taken.
 */
export async function allModels(ctx: ModelsContext): Promise<ModelView[]> {
  const catalogue = ctx.catalogue.current();
  const custom = (await listCustomModels(ctx.db)).map(fromCustom);
  const taken = new Set(custom.map((m) => m.id));
  const listed = [...catalogue.models.values(), ...catalogue.feedOnly.values()].filter(
    (m) => !taken.has(m.id) || catalogue.models.has(m.id),
  );
  return [...custom, ...listed.map((m) => fromCatalogue(catalogue, m))];
}

export async function listModels(ctx: ModelsContext, principal: Principal): Promise<ModelView[]> {
  requireManager(principal);
  return allModels(ctx);
}

/** Bundled ids only: a custom model may take a feed-only id, and then wins over the feed. */
function refuseCatalogueId(ctx: ModelsContext, input: CustomModelBody): void {
  if (ctx.catalogue.bundled.models.has(`${input.provider}:${input.model}`)) {
    throw new ModelExistsError('the catalogue already has this model and its price');
  }
}

export async function createCustomModel(
  ctx: ModelsContext,
  principal: Principal,
  input: CustomModelBody,
): Promise<ModelView> {
  requireManager(principal);
  refuseCatalogueId(ctx, input);
  return fromCustom(await insertCustomModel(ctx.db, input, principal.actingUserId));
}

export async function changeCustomModel(
  ctx: ModelsContext,
  principal: Principal,
  customModelId: string,
  input: CustomModelBody,
): Promise<ModelView> {
  requireManager(principal);
  refuseCatalogueId(ctx, input);
  const row = await updateCustomModel(ctx.db, customModelId, input);
  if (row === undefined) throw new NotFoundError('no custom model with this id');
  return fromCustom(row);
}

export async function removeCustomModel(
  ctx: ModelsContext,
  principal: Principal,
  customModelId: string,
): Promise<void> {
  requireManager(principal);
  if (!(await deleteCustomModel(ctx.db, customModelId))) {
    throw new NotFoundError('no custom model with this id');
  }
}
