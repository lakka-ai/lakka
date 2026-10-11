import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationLockTimeoutError, SchemaMismatchError } from '@lakka/contracts';
import { MIGRATION_LOCK_KEY, MIGRATIONS_FOLDER, migrate } from '../src/migrate.ts';
import type { Pool } from '../src/pool.ts';
import { createTestDatabase, postgresImage } from '../../../test/integration/postgres.ts';
import type { TestDatabase } from '../../../test/integration/postgres.ts';

const fixtures = fileURLToPath(new URL('./fixtures/migrations', import.meta.url));
const folder = (name: string) => join(fixtures, name);

let db: TestDatabase | undefined;
afterEach(async () => {
  await db?.drop();
  db = undefined;
});

async function fresh(): Promise<{ db: TestDatabase; pool: Pool }> {
  db = await createTestDatabase();
  return { db, pool: db.pool() };
}

async function appliedTags(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: string }>(
    'select count(*) as n from drizzle.__drizzle_migrations',
  );
  return Number(r.rows[0]?.n);
}

async function tables(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  return r.rows.map((row) => row.table_name);
}

describe(`migrations on ${postgresImage()}`, () => {
  it('AD-4: applies every pending migration to an empty database', async () => {
    const { pool } = await fresh();
    const result = await migrate(pool, { migrationsFolder: folder('base') });
    expect(result.applied).toEqual(['0000_create_widgets', '0001_create_parts']);
    expect(await tables(pool)).toEqual(['parts', 'widgets']);
    expect(await appliedTags(pool)).toBe(2);
  });

  it('AD-4: running again is a no-op', async () => {
    const { pool } = await fresh();
    await migrate(pool, { migrationsFolder: folder('base') });
    const second = await migrate(pool, { migrationsFolder: folder('base') });
    expect(second.applied).toEqual([]);
    expect(await appliedTags(pool)).toBe(2);
  });

  it('AD-4: an upgrade applies only the new migration', async () => {
    const { pool } = await fresh();
    await migrate(pool, { migrationsFolder: folder('base') });
    const upgrade = await migrate(pool, { migrationsFolder: folder('next') });
    expect(upgrade.applied).toEqual(['0002_add_part_label']);
    const columns = await pool.query(
      "select 1 from information_schema.columns where table_name = 'parts' and column_name = 'label'",
    );
    expect(columns.rowCount).toBe(1);
  });

  it('AD-4: concurrent starts apply each migration exactly once', async () => {
    const { db: database } = await fresh();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        migrate(database.pool(1), { migrationsFolder: folder('next') }),
      ),
    );
    const appliedCounts = results.map((r) => r.applied.length).toSorted();
    expect(appliedCounts).toEqual([0, 0, 0, 0, 0, 3]);
    expect(await appliedTags(database.pool(1))).toBe(3);
  });

  it('NF-O1: refuses to start when the database is ahead of this version', async () => {
    const { pool } = await fresh();
    await migrate(pool, { migrationsFolder: folder('next') });
    await expect(migrate(pool, { migrationsFolder: folder('base') })).rejects.toThrow(
      SchemaMismatchError,
    );
    expect(await appliedTags(pool)).toBe(3);
  });

  it('NF-O1: refuses when an applied migration was edited', async () => {
    const { pool } = await fresh();
    await migrate(pool, { migrationsFolder: folder('base') });
    await expect(migrate(pool, { migrationsFolder: folder('edited') })).rejects.toThrow(
      /changed after it was applied/,
    );
  });

  it('NF-O1: refuses an older migration merged in after newer ones were applied', async () => {
    const { pool } = await fresh();
    await migrate(pool, { migrationsFolder: folder('base') });
    await expect(migrate(pool, { migrationsFolder: folder('merged-late') })).rejects.toThrow(
      /older than the newest applied/,
    );
    expect(await tables(pool)).not.toContain('cogs');
  });

  it('NF-O1: a failing migration rolls back completely', async () => {
    const { pool } = await fresh();
    await migrate(pool, { migrationsFolder: folder('base') });
    await expect(migrate(pool, { migrationsFolder: folder('broken') })).rejects.toThrow(
      /no_such_table/,
    );
    expect(await tables(pool)).toEqual(['parts', 'widgets']);
    expect(await appliedTags(pool)).toBe(2);
  });

  it('NF-O1: verify mode refuses when migrations are pending and changes nothing', async () => {
    const { pool } = await fresh();
    await expect(
      migrate(pool, { migrationsFolder: folder('base'), mode: 'verify' }),
    ).rejects.toThrow(/missing 2 migration/);
    expect(await tables(pool)).toEqual([]);
  });

  it('gives up with a typed error when another process holds the lock too long', async () => {
    const { db: database } = await fresh();
    const holder = await database.pool(1).connect();
    await holder.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await expect(
        migrate(database.pool(1), { migrationsFolder: folder('base'), lockTimeoutMs: 300 }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      await holder.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      holder.release();
    }
  });

  it('applies the migrations this version ships', async () => {
    const { pool } = await fresh();
    await expect(migrate(pool, { migrationsFolder: MIGRATIONS_FOLDER })).resolves.toMatchObject({
      applied: expect.any(Array),
    });
    await expect(migrate(pool, { mode: 'verify' })).resolves.toMatchObject({ applied: [] });
  });
});
