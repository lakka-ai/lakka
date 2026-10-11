import { customType } from 'drizzle-orm/pg-core';

/*
 * A pgvector column with no fixed dimension (ADR 0042). The embedding model is a setting
 * (NF-A3), and a different model means a different dimension, so each row records the model
 * that produced its embedding instead of the column pinning one size.
 */
export const embedding = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => (JSON.parse(value) as unknown[]).map(Number),
});
