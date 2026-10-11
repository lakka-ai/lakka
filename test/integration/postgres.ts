import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import { createPool } from '@lakka/db';
import type { Pool, PoolOptions } from '@lakka/db';
import { POSTGRES_ADMIN_URL, POSTGRES_IMAGE } from './context.ts';

export interface TestDatabase {
  name: string;
  /** Opens another pool on the same database, e.g. to simulate a second process. */
  pool(max?: number): Pool;
  /** How to connect to it, for a child process that opens its own pool. */
  options(): PoolOptions;
  /** Closes every pool opened so far, for a test that needs the database to itself. */
  endPools(): Promise<void>;
  /** Closes every pool it opened and drops the database. */
  drop(): Promise<void>;
}

function adminPool(): Pool {
  const url = new URL(inject(POSTGRES_ADMIN_URL));
  return createPool(
    {
      host: url.hostname,
      port: Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      applicationName: 'lakka-tests-admin',
      max: 1,
    },
    () => undefined,
  );
}

/** A fresh, empty database in the shared container, so tests never see each other's state. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = adminPool();
  await admin.query(`create database "${name}"`);
  const url = new URL(inject(POSTGRES_ADMIN_URL));
  const pools: Pool[] = [];
  return {
    name,
    pool(max = 5) {
      const pool = createPool(
        {
          host: url.hostname,
          port: Number(url.port),
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          database: name,
          applicationName: 'lakka-tests',
          max,
        },
        () => undefined,
      );
      pools.push(pool);
      return pool;
    },
    options() {
      return {
        host: url.hostname,
        port: Number(url.port),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: name,
        applicationName: 'lakka-tests-child',
      };
    },
    async endPools() {
      await Promise.all(pools.filter((p) => !p.ending).map((p) => p.end()));
    },
    async drop() {
      await Promise.all(pools.filter((p) => !p.ending).map((p) => p.end()));
      await admin.query(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}

/** The Postgres image this run is testing against, for test titles. */
export function postgresImage(): string {
  return inject(POSTGRES_IMAGE);
}
