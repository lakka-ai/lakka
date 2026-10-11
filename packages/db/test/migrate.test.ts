import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SchemaMismatchError } from '@lakka/contracts';
import { MIGRATIONS_FOLDER, plan, readMigrations } from '../src/migrate.ts';

const fixtures = fileURLToPath(new URL('./fixtures/migrations', import.meta.url));
const read = (name: string) => readMigrations(join(fixtures, name));
const applied = (name: string) => read(name).map((m) => ({ hash: m.hash, createdAt: m.createdAt }));

describe('readMigrations', () => {
  it('reads drizzle-kit journals in order and splits statements at breakpoints', () => {
    const migrations = read('base');
    expect(migrations.map((m) => m.tag)).toEqual(['0000_create_widgets', '0001_create_parts']);
    expect(migrations[1]?.statements).toHaveLength(2);
    expect(migrations[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a folder without a journal as having no migrations', () => {
    expect(readMigrations(join(fixtures, 'does-not-exist'))).toEqual([]);
  });

  it('reads the shipped migrations folder', () => {
    expect(() => readMigrations(MIGRATIONS_FOLDER)).not.toThrow();
  });

  it('NF-O1: rejects a journal whose entries are not in time order', () => {
    expect(() => read('unsorted-journal')).toThrow(SchemaMismatchError);
  });
});

describe('plan', () => {
  it('AD-4: everything is pending on an empty database', () => {
    expect(plan(read('base'), []).map((m) => m.tag)).toEqual([
      '0000_create_widgets',
      '0001_create_parts',
    ]);
  });

  it('AD-4: only newer migrations are pending on an existing database', () => {
    expect(plan(read('next'), applied('base')).map((m) => m.tag)).toEqual(['0002_add_part_label']);
  });

  it('NF-O1: refuses when the database has migrations this version does not know', () => {
    expect(() => plan(read('base'), applied('next'))).toThrow(/does not include/);
  });

  it('NF-O1: refuses when an applied migration was edited', () => {
    expect(() => plan(read('edited'), applied('base'))).toThrow(/changed after it was applied/);
  });

  it('NF-O1: refuses a pending migration older than the newest applied one', () => {
    expect(() => plan(read('merged-late'), applied('base'))).toThrow(
      /older than the newest applied/,
    );
  });
});
