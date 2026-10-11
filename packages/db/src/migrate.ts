import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { MigrationLockTimeoutError, SchemaMismatchError } from '@lakka/contracts';
import type { Pool } from './pool.ts';

/*
 * Forward-only migrations, applied automatically at startup (AD-4, NF-O1, ADR 0026).
 *
 * The files are drizzle-kit's format (migrations/meta/_journal.json plus one .sql file per
 * entry), and applied migrations are recorded in drizzle's table, drizzle.__drizzle_migrations,
 * with the same sha256 hash. We apply them ourselves rather than calling drizzle's migrate(),
 * because that function only compares timestamps against the newest applied row: it never notices
 * a database that is ahead of the code or an edited migration, and it silently skips an older
 * migration that arrives later. It also has no lock.
 *
 * Rules, checked under a Postgres advisory lock so concurrent processes cannot interleave:
 *   1. Every applied migration must exist in this version with the same hash. Otherwise the
 *      database is ahead (a downgrade or diverged history) or a migration was edited: refuse.
 *   2. Pending migrations must all be newer than the newest applied one. Otherwise history
 *      diverged: refuse.
 *   3. mode 'migrate' applies the pending ones in one transaction; mode 'verify' refuses if any
 *      are pending.
 *
 * Migrations must be transactional: no CREATE INDEX CONCURRENTLY and similar statements.
 */

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';
const BREAKPOINT = '--> statement-breakpoint';

/** Fixed advisory lock key for migrations. Arbitrary, but must never change. */
export const MIGRATION_LOCK_KEY = 7_319_224_601;

export interface Migration {
  tag: string;
  /** drizzle-kit's `when`, in milliseconds; also the created_at recorded when applied. */
  createdAt: number;
  hash: string;
  statements: string[];
}

export interface MigrateOptions {
  migrationsFolder?: string;
  /** 'migrate' applies pending migrations; 'verify' refuses to continue if any are pending. */
  mode?: 'migrate' | 'verify';
  /** How long to wait for another process holding the migration lock. */
  lockTimeoutMs?: number;
}

export interface MigrateResult {
  applied: string[];
  total: number;
}

interface Journal {
  entries: { tag: string; when: number }[];
}

/** Reads migrations in journal order. A folder without a journal has no migrations. */
export function readMigrations(folder: string): Migration[] {
  const journalPath = join(folder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) return [];
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const migrations = journal.entries.map((entry) => {
    const sql = readFileSync(join(folder, `${entry.tag}.sql`), 'utf8');
    return {
      tag: entry.tag,
      createdAt: entry.when,
      hash: createHash('sha256').update(sql).digest('hex'),
      statements: sql
        .split(BREAKPOINT)
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    };
  });
  for (let i = 1; i < migrations.length; i += 1) {
    const previous = migrations[i - 1];
    const current = migrations[i];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.createdAt <= previous.createdAt
    ) {
      throw new SchemaMismatchError(
        `migration ${current.tag} is not newer than ${previous.tag} in the journal`,
      );
    }
  }
  return migrations;
}

export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = readMigrations(options.migrationsFolder ?? MIGRATIONS_FOLDER);
  const client = await pool.connect();
  let locked = false;
  try {
    await acquireLock(client, options.lockTimeoutMs ?? 60_000);
    locked = true;

    const applied = await readApplied(client);
    const pending = plan(migrations, applied);

    if (pending.length > 0 && options.mode === 'verify') {
      throw new SchemaMismatchError(
        `the database is missing ${pending.length} migration(s): ${pending.map((m) => m.tag).join(', ')}`,
      );
    }
    if (pending.length > 0) await apply(client, pending);
    return { applied: pending.map((m) => m.tag), total: migrations.length };
  } finally {
    if (locked) {
      await client
        .query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
    client.release();
  }
}

async function acquireLock(client: PoolClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1) as locked',
      [MIGRATION_LOCK_KEY],
    );
    if (result.rows[0]?.locked === true) return;
    if (Date.now() >= deadline) {
      throw new MigrationLockTimeoutError(
        `another process held the migration lock for more than ${timeoutMs} ms`,
      );
    }
    await sleep(100);
  }
}

interface AppliedRow {
  hash: string;
  created_at: string;
}

async function readApplied(client: PoolClient): Promise<{ hash: string; createdAt: number }[]> {
  const exists = await client.query<{ exists: boolean }>(
    'select to_regclass($1) is not null as exists',
    [`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`],
  );
  if (exists.rows[0]?.exists !== true) return [];
  const result = await client.query<AppliedRow>(
    `select hash, created_at from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" order by created_at, id`,
  );
  return result.rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
}

/** Validates applied history against this version and returns what is pending. */
export function plan(
  migrations: readonly Migration[],
  applied: readonly { hash: string; createdAt: number }[],
): Migration[] {
  const byCreatedAt = new Map(migrations.map((m) => [m.createdAt, m]));
  for (const row of applied) {
    const known = byCreatedAt.get(row.createdAt);
    if (known === undefined) {
      throw new SchemaMismatchError(
        `the database has a migration from ${new Date(row.createdAt).toISOString()} that this version does not include; ` +
          'it was probably created by a newer version, and downgrades are not supported',
      );
    }
    if (known.hash !== row.hash) {
      throw new SchemaMismatchError(`migration ${known.tag} was changed after it was applied`);
    }
  }
  const appliedAt = new Set(applied.map((row) => row.createdAt));
  const pending = migrations.filter((m) => !appliedAt.has(m.createdAt));
  const newestApplied = Math.max(0, ...applied.map((row) => row.createdAt));
  const stale = pending.find((m) => m.createdAt < newestApplied);
  if (stale !== undefined) {
    throw new SchemaMismatchError(
      `pending migration ${stale.tag} is older than the newest applied migration; regenerate it`,
    );
  }
  return pending;
}

async function apply(client: PoolClient, pending: readonly Migration[]): Promise<void> {
  await client.query('begin');
  try {
    await client.query(`create schema if not exists "${MIGRATIONS_SCHEMA}"`);
    await client.query(
      `create table if not exists "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
         id serial primary key,
         hash text not null,
         created_at bigint
       )`,
    );
    for (const migration of pending) {
      for (const statement of migration.statements) await client.query(statement);
      await client.query(
        `insert into "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (hash, created_at) values ($1, $2)`,
        [migration.hash, migration.createdAt],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}
