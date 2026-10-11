import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import {
  ConfigError,
  CredentialKeyInUseError,
  CredentialKeyMismatchError,
  CredentialKeyMissingError,
  CredentialKeyUnavailableError,
  CredentialUnreadableError,
  DatabaseInUseError,
} from '@lakka/contracts';
import {
  credentialKeyFingerprint,
  decryptWithRing,
  encryptedColumns,
  encryptWithRing,
} from '../crypto.ts';
import type { CredentialKeyRing, EncryptedColumn } from '../crypto.ts';
import type { Pool } from '../pool.ts';
import * as schema from '../schema/index.ts';

/*
 * The credential master key's versions in Postgres, and rotating stored values from one
 * version to the next (NF-S1, NF-S9, ADR 0115). Postgres records which version is active and a
 * fingerprint of each key, never a key.
 *
 * These read and write across workspaces on purpose: encrypted columns belong to the instance's
 * key, not to a workspace, and rotation must reach every value. Nothing here returns a value.
 */

export interface CredentialKeyRow {
  version: number;
  keyId: string;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

type Queryable = Pick<Pool, 'query'> | PoolClient;

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Every recorded version. `forShare` waits for a rotation that holds the active row, so a
 * process starting during one sees its outcome rather than the version it replaces.
 */
export async function readCredentialKeys(
  db: Queryable,
  options: { forShare?: boolean } = {},
): Promise<CredentialKeyRow[]> {
  const result = await db.query<{
    version: number;
    key_id: string;
    created_at: Date;
    activated_at: Date | null;
    retired_at: Date | null;
  }>(
    `select version, key_id, created_at, activated_at, retired_at
     from credential_keys order by version${options.forShare === true ? ' for share' : ''}`,
  );
  return result.rows.map((r) => ({
    version: r.version,
    keyId: r.key_id,
    createdAt: r.created_at,
    activatedAt: r.activated_at,
    retiredAt: r.retired_at,
  }));
}

/** The active version: the highest one writes were switched to. */
export function activeVersionOf(rows: CredentialKeyRow[]): number | undefined {
  return rows
    .filter((r) => r.activatedAt !== null)
    .reduce<number | undefined>(
      (max, r) => (max === undefined || r.version > max ? r.version : max),
      undefined,
    );
}

interface Target extends EncryptedColumn {
  primaryKey: string;
}

/** Each registered encrypted column with its table's primary key, from the schema itself. */
export function encryptedColumnTargets(): Target[] {
  const primaryKeys = new Map<string, string>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const primary = config.columns.filter((c) => c.primary);
    if (primary.length === 1 && primary[0] !== undefined) {
      primaryKeys.set(config.name, primary[0].name);
    }
  }
  return encryptedColumns().map((column) => {
    const primaryKey = primaryKeys.get(column.table);
    // Rotation rewrites one row at a time by its key; a table without a single-column primary
    // key could not be rotated safely, so the schema must not have one.
    if (primaryKey === undefined) {
      throw new Error(`encrypted column ${column.context} has no single-column primary key`);
    }
    return { ...column, primaryKey };
  });
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Client connections to this database other than the caller's. Rotation and retirement need
 * the database to themselves, as restore does: a running api or worker would keep writing with
 * the version it started with.
 */
export async function countOtherConnections(db: Queryable): Promise<number> {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from pg_stat_activity
     where datname = current_database() and pid <> pg_backend_pid()
       and backend_type = 'client backend'`,
  );
  return result.rows[0]?.count ?? 0;
}

async function refuseIfOthersConnected(db: Queryable): Promise<void> {
  const others = await countOtherConnections(db);
  if (others > 0) throw new DatabaseInUseError(others);
}

/** One stored value from any encrypted column, to check a key against before recording it. */
async function sampleValue(
  db: Queryable,
): Promise<{ value: string; context: string; id: string } | undefined> {
  for (const target of encryptedColumnTargets()) {
    const result = await db.query<{ id: string; value: string }>(
      `select ${quote(target.primaryKey)}::text as id, ${quote(target.column)} as value
       from ${quote(target.table)} where ${quote(target.column)} is not null limit 1`,
    );
    const row = result.rows[0];
    if (row !== undefined) return { ...row, context: target.context };
  }
  return undefined;
}

/**
 * Startup (ADR 0115): works out the active version and checks the given keys against what
 * Postgres recorded. Refuses with CredentialKeyMissingError when the active key was not given,
 * and CredentialKeyMismatchError when a given key is not the recorded one.
 *
 * The first start after upgrading to key versions finds no rows. It adopts the original key as
 * v1, but only once a stored value decrypts with it, so a wrong key is never recorded as right.
 */
export async function prepareCredentialKeyRing(
  pool: Queryable,
  keys: ReadonlyMap<number, Buffer>,
): Promise<CredentialKeyRing> {
  let rows = await readCredentialKeys(pool, { forShare: true });
  if (rows.length === 0) {
    const original = keys.get(1);
    if (original === undefined) throw new CredentialKeyMissingError(1);
    const sample = await sampleValue(pool);
    if (sample !== undefined) {
      try {
        decryptWithRing({ active: 1, keys }, sample.value, sample.context);
      } catch (error) {
        if (error instanceof CredentialKeyUnavailableError) {
          throw new CredentialKeyMissingError(error.version, { cause: error });
        }
        throw new CredentialKeyMismatchError(1, { cause: error });
      }
    }
    await pool.query(
      `insert into credential_keys (version, key_id, activated_at) values (1, $1, now())
       on conflict (version) do nothing`,
      [credentialKeyFingerprint(original)],
    );
    rows = await readCredentialKeys(pool, { forShare: true });
  }
  const active = activeVersionOf(rows);
  if (active === undefined) throw new ConfigError('no credential key version is active');
  if (!keys.has(active)) throw new CredentialKeyMissingError(active);
  for (const row of rows) {
    const key = keys.get(row.version);
    if (key === undefined || row.retiredAt !== null) continue;
    if (credentialKeyFingerprint(key) !== row.keyId) {
      throw new CredentialKeyMismatchError(row.version);
    }
  }
  return { active, keys };
}

/** Locks the active row against another rotation or retirement, and returns its version. */
async function lockActive(client: PoolClient): Promise<number> {
  const result = await client.query<{ version: number }>(
    `select version from credential_keys where activated_at is not null
     order by version desc limit 1 for update`,
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new ConfigError('no credential key version is active');
  return version;
}

export interface RotateCredentialsOptions {
  /** Every key needed: the versions stored values name, and the new one. */
  keys: ReadonlyMap<number, Buffer>;
  /** The version active when the rotation was planned; another rotation since refuses this one. */
  from: number;
  to: number;
  /** Called after each value is rewritten, inside the transaction. Tests pause here. */
  afterValue?: (rewritten: number) => Promise<void>;
}

/**
 * Rewrites every encrypted value under the new version and makes it active, in one
 * transaction: a crash at any point leaves either every value and the active version as they
 * were, or all of them changed. A value that does not decrypt aborts the whole rotation, named
 * by column and row id.
 *
 * Each update matches the value it read, so a row changed by anything else is never
 * overwritten with an older secret.
 */
export async function rotateCredentialValues(
  pool: Pool,
  options: RotateCredentialsOptions,
): Promise<{ rewritten: number }> {
  const target = options.keys.get(options.to);
  if (target === undefined) throw new CredentialKeyUnavailableError(options.to);
  const reading: CredentialKeyRing = { active: options.from, keys: options.keys };
  const writing: CredentialKeyRing = { active: options.to, keys: options.keys };
  return inTransaction(pool, async (client) => {
    const active = await lockActive(client);
    if (active !== options.from) {
      throw new ConfigError(
        `credential key v${active} became active while this rotation was starting; run it again`,
      );
    }
    await refuseIfOthersConnected(client);
    const recorded = await client.query<{ key_id: string }>(
      'select key_id from credential_keys where version = $1',
      [options.to],
    );
    const fingerprint = credentialKeyFingerprint(target);
    if (recorded.rows[0] !== undefined && recorded.rows[0].key_id !== fingerprint) {
      throw new CredentialKeyMismatchError(options.to);
    }

    let rewritten = 0;
    for (const column of encryptedColumnTargets()) {
      const table = quote(column.table);
      const col = quote(column.column);
      const pk = quote(column.primaryKey);
      const rows = await client.query<{ id: string; value: string }>(
        `select ${pk}::text as id, ${col} as value from ${table}
         where ${col} is not null and ${col} not like $1 order by ${pk}`,
        [`v${options.to}:%`],
      );
      for (const row of rows.rows) {
        let plaintext: string;
        try {
          plaintext = decryptWithRing(reading, row.value, column.context);
        } catch (error) {
          throw new CredentialUnreadableError(column.context, row.id, { cause: error });
        }
        const updated = await client.query(
          `update ${table} set ${col} = $1 where ${pk} = $2 and ${col} = $3`,
          [encryptWithRing(writing, plaintext, column.context), row.id, row.value],
        );
        if (updated.rowCount !== 1) {
          throw new ConfigError(`${column.context} in row ${row.id} changed during the rotation`);
        }
        rewritten += 1;
        await options.afterValue?.(rewritten);
      }
    }

    await client.query(
      `insert into credential_keys (version, key_id, activated_at) values ($1, $2, now())
       on conflict (version) do update set activated_at = now(), retired_at = null`,
      [options.to, fingerprint],
    );
    return { rewritten };
  });
}

/**
 * Columns that still hold a value encrypted under a version other than `active`: every
 * encrypted column, and any other text column in the schema that holds something in the stored
 * format, such as a copy an export or a future column made. Retiring a key those need would
 * make them unreadable.
 */
export async function findOlderCredentialValues(
  db: Queryable,
  active: number,
): Promise<{ column: string; count: number }[]> {
  const found: { column: string; count: number }[] = [];
  const registered = new Set<string>();
  for (const target of encryptedColumnTargets()) {
    registered.add(target.context);
    const result = await db.query<{ count: number }>(
      `select count(*)::int as count from ${quote(target.table)}
       where ${quote(target.column)} is not null and ${quote(target.column)} not like $1`,
      [`v${active}:%`],
    );
    const count = result.rows[0]?.count ?? 0;
    if (count > 0) found.push({ column: target.context, count });
  }
  const columns = await db.query<{ table: string; column: string }>(
    `select c.relname as table, a.attname as column
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
       and a.attnum > 0 and not a.attisdropped
       and a.atttypid in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype)
     order by c.relname, a.attname`,
  );
  for (const { table, column } of columns.rows) {
    if (registered.has(`${table}.${column}`)) continue;
    const result = await db.query<{ count: number }>(
      `select count(*)::int as count from ${quote(table)}
       where ${quote(column)} ~ '^v[0-9]+:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$'
         and ${quote(column)} not like $1`,
      [`v${active}:%`],
    );
    const count = result.rows[0]?.count ?? 0;
    if (count > 0) found.push({ column: `${table}.${column}`, count });
  }
  return found;
}

/**
 * Marks every version older than the active one retired, once nothing stored needs them.
 * Returns the versions retired by this call. The caller removes their key files afterwards; a
 * crash in between leaves files that a rerun removes.
 */
export async function retireCredentialKeys(
  pool: Pool,
): Promise<{ active: number; retired: number[] }> {
  return inTransaction(pool, async (client) => {
    const active = await lockActive(client);
    await refuseIfOthersConnected(client);
    const older = await findOlderCredentialValues(client, active);
    if (older.length > 0) {
      const where = older.map((o) => `${o.column} (${o.count})`).join(', ');
      throw new CredentialKeyInUseError(`older key versions still encrypt values in ${where}`, {
        columns: older,
      });
    }
    const result = await client.query<{ version: number }>(
      `update credential_keys set retired_at = now()
       where version < $1 and retired_at is null returning version`,
      [active],
    );
    return { active, retired: result.rows.map((r) => r.version).toSorted((a, b) => a - b) };
  });
}
