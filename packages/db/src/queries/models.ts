import { asc, eq, sql } from 'drizzle-orm';
import { ModelExistsError } from '@lakka/contracts';
import type { CustomModelBody } from '@lakka/contracts';
import type { Db } from '../client.ts';
import { customModels } from '../schema/models.ts';

/* Custom models (PR-7). Instance-wide, like the catalogue they extend; not tenant data. */

export type CustomModelRow = typeof customModels.$inferSelect;

function values(input: CustomModelBody) {
  return {
    modelRef: `${input.provider}:${input.model}`,
    provider: input.provider,
    model: input.model,
    displayName: input.displayName ?? null,
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    capabilities: input.capabilities,
    inputMicroUsdPerMtok: input.prices.inputMicroUsdPerMtok,
    outputMicroUsdPerMtok: input.prices.outputMicroUsdPerMtok,
    cacheReadMicroUsdPerMtok: input.prices.cacheReadMicroUsdPerMtok,
    cacheWriteMicroUsdPerMtok: input.prices.cacheWriteMicroUsdPerMtok,
  };
}

function isRefTaken(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint' in current &&
      current.constraint === 'custom_models_model_ref_key'
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function refTakenAsExists<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isRefTaken(error)) {
      throw new ModelExistsError('a model with this id already exists', { cause: error });
    }
    throw error;
  }
}

export async function listCustomModels(db: Db): Promise<CustomModelRow[]> {
  return db.select().from(customModels).orderBy(asc(customModels.modelRef));
}

export async function findCustomModelByRef(
  db: Db,
  modelRef: string,
): Promise<CustomModelRow | undefined> {
  const [row] = await db
    .select()
    .from(customModels)
    .where(eq(customModels.modelRef, modelRef))
    .limit(1);
  return row;
}

export async function insertCustomModel(
  db: Db,
  input: CustomModelBody,
  createdByPrincipalId: string,
): Promise<CustomModelRow> {
  return refTakenAsExists(async () => {
    const [row] = await db
      .insert(customModels)
      .values({ ...values(input), createdByPrincipalId })
      .returning();
    if (row === undefined) throw new Error('custom model insert returned nothing');
    return row;
  });
}

/** Returns the updated row, or undefined if there is no such custom model. */
export async function updateCustomModel(
  db: Db,
  id: string,
  input: CustomModelBody,
): Promise<CustomModelRow | undefined> {
  return refTakenAsExists(async () => {
    const [row] = await db
      .update(customModels)
      .set({ ...values(input), updatedAt: sql`now()` })
      .where(eq(customModels.id, id))
      .returning();
    return row;
  });
}

export async function deleteCustomModel(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(customModels)
    .where(eq(customModels.id, id))
    .returning({ id: customModels.id });
  return rows.length > 0;
}
