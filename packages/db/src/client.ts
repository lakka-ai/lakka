import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from './pool.ts';
import * as schema from './schema/index.ts';

/** Typed query builder over the shared pool. Tenant-scoped helpers build on this. */
export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
