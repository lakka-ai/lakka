import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';

export type { Pool, QueryResult };

export interface PoolOptions {
  host: string;
  port: number;
  user: string;
  database: string;
  password: string | undefined;
  applicationName: string;
  max?: number;
}

/**
 * Creates the Postgres pool. `onIdleError` must be supplied: pg emits 'error' for idle clients
 * that lose their connection, and an unhandled 'error' event would crash the process.
 */
export function createPool(options: PoolOptions, onIdleError: (err: Error) => void): Pool {
  const pool = new Pool({
    host: options.host,
    port: options.port,
    user: options.user,
    database: options.database,
    ...(options.password === undefined ? {} : { password: options.password }),
    application_name: options.applicationName,
    max: options.max ?? 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', onIdleError);
  return pool;
}

export async function pingDatabase(pool: Pool): Promise<void> {
  await pool.query('select 1');
}

/**
 * Waits until Postgres answers, with capped exponential backoff. Startup needs the database
 * before it can check migrations; compose healthchecks usually make the first try succeed.
 */
export async function waitForDatabase(
  pool: Pool,
  onRetry: (attempt: number, delayMs: number, error: unknown) => void,
  maxDelayMs = 10_000,
): Promise<number> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pingDatabase(pool);
      return attempt;
    } catch (error) {
      const delay = Math.min(maxDelayMs, 250 * 2 ** Math.min(attempt, 6));
      onRetry(attempt, delay, error);
      await sleep(delay);
    }
  }
}

/**
 * Runs `fn` while holding a session advisory lock, or returns false at once if another process
 * holds it: periodic jobs run in one worker at a time without waiting on each other.
 */
export async function withAdvisoryLock(
  pool: Pool,
  key: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1) as locked',
      [key],
    );
    if (result.rows[0]?.locked !== true) return false;
    try {
      await fn();
    } finally {
      await client.query('select pg_advisory_unlock($1)', [key]);
    }
    return true;
  } finally {
    client.release();
  }
}
