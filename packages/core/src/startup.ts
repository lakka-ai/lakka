import { ensureMonthlyPartitions, migrate, waitForDatabase } from '@lakka/db';
import type { MigrateOptions, MigrateResult, Pool } from '@lakka/db';
import type { Logger } from './logger.ts';

/**
 * Startup gate shared by every process that touches the database (AD-4, NF-O1, ADR 0026):
 * wait for Postgres, then apply pending migrations under the migration lock, or refuse, and make
 * sure upcoming monthly partitions exist. Throws
 * SchemaMismatchError when the database does not match this version; the caller must exit
 * rather than serve.
 */
export async function ensureDatabaseReady(
  pool: Pool,
  logger: Logger,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  await waitForDatabase(pool, (attempt, delayMs, error) =>
    logger.warn('database.unavailable', { attempt, delay_ms: delayMs }, error),
  );
  const result = await migrate(pool, options);
  logger.info('database.schema_ready', {
    count: result.applied.length,
    status: result.applied.length > 0 ? 'migrated' : 'current',
  });
  // Usage and spans are partitioned by month; the partitions for this month and the next two
  // must exist before anything is billed or traced (ADR 0039, ADR 0076). Commands that only
  // verify the schema skip this.
  if (options.mode !== 'verify') {
    const created = await ensureMonthlyPartitions(pool);
    if (created > 0) logger.info('database.partitions_created', { count: created });
  }
  return result;
}
