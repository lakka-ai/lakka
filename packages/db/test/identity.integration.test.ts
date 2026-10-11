import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.ts';
import type { Db } from '../src/client.ts';
import { migrate } from '../src/migrate.ts';
import { authUsers } from '../src/schema/auth.ts';
import { apiKeys, memberships, principals, workspaces } from '../src/schema/identity.ts';
import { instanceSetup, invites } from '../src/schema/onboarding.ts';
import { uuidv7Timestamp } from '../src/uuid.ts';
import { createTestDatabase, postgresImage } from '../../../test/integration/postgres.ts';
import type { TestDatabase } from '../../../test/integration/postgres.ts';

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await createTestDatabase();
  const pool = database.pool();
  await migrate(pool);
  db = createDb(pool);
});

afterAll(async () => {
  await database.drop();
});

const unique = () => randomBytes(4).toString('hex');

async function user(overrides: Partial<typeof principals.$inferInsert> = {}) {
  const [row] = await db
    .insert(principals)
    .values({
      kind: 'user',
      displayName: 'Ada',
      email: `ada-${unique()}@example.com`,
      ...overrides,
    })
    .returning();
  if (row === undefined) throw new Error('insert returned nothing');
  return row;
}

async function key(
  ownerPrincipalId: string,
  overrides: Partial<typeof principals.$inferInsert> = {},
) {
  const [row] = await db
    .insert(principals)
    .values({ kind: 'key', displayName: 'CI key', ownerPrincipalId, ...overrides })
    .returning();
  if (row === undefined) throw new Error('insert returned nothing');
  return row;
}

async function workspace() {
  const slug = `ws-${unique()}`;
  const [row] = await db.insert(workspaces).values({ name: slug, slug }).returning();
  if (row === undefined) throw new Error('insert returned nothing');
  return row;
}

const hash = () => randomBytes(32).toString('hex');

interface PgError {
  code: string;
  constraint?: string;
}

/** Awaits a query that must fail and returns the Postgres error under drizzle's wrapper. */
async function pgError(query: PromiseLike<unknown>): Promise<PgError> {
  try {
    await query;
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      if (
        'code' in current &&
        typeof current.code === 'string' &&
        /^[0-9A-Z]{5}$/.test(current.code)
      ) {
        return {
          code: current.code,
          ...('constraint' in current ? { constraint: String(current.constraint) } : {}),
        };
      }
      current = current.cause;
    }
    throw error;
  }
  throw new Error('query succeeded but was expected to fail');
}

const CHECK = '23514';
const FOREIGN_KEY = '23503';
const UNIQUE = '23505';

describe(`identity schema on ${postgresImage()}`, () => {
  it('ID-1: people and keys are both principals with time-ordered UUIDv7 ids', async () => {
    const before = Date.now();
    const person = await user();
    const apiKey = await key(person.id);
    expect(person.id).toMatch(/^[0-9a-f-]{14}7/);
    expect(uuidv7Timestamp(apiKey.id)).toBeGreaterThanOrEqual(before);
    expect(apiKey.ownerPrincipalId).toBe(person.id);
    expect(person.status).toBe('active');
  });

  it('ID-5: a key must have an owner', async () => {
    const error = await pgError(
      db.insert(principals).values({ kind: 'key', displayName: 'orphan' }),
    );
    expect(error).toEqual({ code: CHECK, constraint: 'principals_key_has_owner_check' });
  });

  it('ID-5: a user cannot have an owner', async () => {
    const owner = await user();
    const error = await pgError(user({ ownerPrincipalId: owner.id }));
    expect(error.code).toBe(CHECK);
  });

  it('ID-5, NF-S2: a key is owned by a user, never by another key', async () => {
    const owner = await user();
    const first = await key(owner.id);
    const error = await pgError(key(first.id));
    expect(error).toEqual({ code: FOREIGN_KEY, constraint: 'principals_owner_is_user_fkey' });
  });

  it('ID-5: a key carries no sign-in identity and cannot be an instance admin', async () => {
    const owner = await user();
    expect((await pgError(key(owner.id, { authSubject: `sub-${unique()}` }))).constraint).toBe(
      'principals_key_fields_check',
    );
    expect((await pgError(key(owner.id, { isInstanceAdmin: true }))).constraint).toBe(
      'principals_key_fields_check',
    );
    expect((await pgError(key(owner.id, { email: 'key@example.com' }))).constraint).toBe(
      'principals_user_has_email_check',
    );
  });

  it('ID-2: a user has an email, unique regardless of case', async () => {
    expect((await pgError(user({ email: null }))).constraint).toBe(
      'principals_user_has_email_check',
    );
    const email = `grace-${unique()}@example.com`;
    await user({ email });
    const error = await pgError(user({ email: email.toUpperCase() }));
    expect(error).toEqual({ code: UNIQUE, constraint: 'principals_email_lower_key' });
  });

  it('ID-2: one principal per Better Auth user, and only for users that exist', async () => {
    const subject = `sub-${unique()}`;
    expect((await pgError(user({ authSubject: subject }))).constraint).toBe(
      'principals_auth_subject_auth_users_id_fk',
    );
    await db
      .insert(authUsers)
      .values({ id: subject, name: 'Ada', email: `${subject}@example.com` });
    await user({ authSubject: subject });
    expect(await pgError(user({ authSubject: subject }))).toEqual({
      code: UNIQUE,
      constraint: 'principals_auth_subject_key',
    });
  });

  it('ID-6, NF-P4: status is active, suspended or deleted', async () => {
    const error = await pgError(
      db.execute(sql`insert into principals (id, kind, display_name, email, status)
        values (gen_random_uuid(), 'user', 'x', ${`x-${unique()}@example.com`}, 'banned')`),
    );
    expect(error).toEqual({ code: CHECK, constraint: 'principals_status_check' });
  });

  it('NF-P4: a deleted principal records when and by whom, and only a deleted person may lack an email', async () => {
    const admin = await user();
    // Deleted, but not saying when or by whom.
    expect((await pgError(user({ status: 'deleted' }))).constraint).toBe(
      'principals_deleted_check',
    );
    expect((await pgError(user({ status: 'deleted', deletedAt: new Date() }))).constraint).toBe(
      'principals_deleted_check',
    );
    // When and by whom, on someone who is not deleted.
    expect(
      (await pgError(user({ deletedAt: new Date(), deletedByPrincipalId: admin.id }))).constraint,
    ).toBe('principals_deleted_check');
    const tombstone = await user({
      status: 'deleted',
      email: null,
      displayName: 'Deleted person',
      deletedAt: new Date(),
      deletedByPrincipalId: admin.id,
    });
    expect(tombstone).toMatchObject({ status: 'deleted', email: null });
    // Still never an email on a key, deleted or not.
    expect(
      (
        await pgError(
          key(admin.id, {
            status: 'deleted',
            email: 'key@example.com',
            deletedAt: new Date(),
            deletedByPrincipalId: admin.id,
          }),
        )
      ).constraint,
    ).toBe('principals_user_has_email_check');
  });

  it('ID-3: instance admin is a flag on a user; workspace roles are admin or member', async () => {
    const admin = await user({ isInstanceAdmin: true });
    expect(admin.isInstanceAdmin).toBe(true);
    const ws = await workspace();
    const error = await pgError(
      db.execute(sql`insert into memberships (workspace_id, principal_id, role)
        values (${ws.id}, ${admin.id}, 'owner')`),
    );
    expect(error).toEqual({ code: CHECK, constraint: 'memberships_role_check' });
  });

  it('ID-4: a person can belong to several workspaces with a different role in each', async () => {
    const person = await user();
    const [a, b] = [await workspace(), await workspace()];
    await db.insert(memberships).values([
      { workspaceId: a.id, principalId: person.id, role: 'admin' },
      { workspaceId: b.id, principalId: person.id, role: 'member' },
    ]);
    const rows = await db
      .select()
      .from(memberships)
      .where(sql`${memberships.principalId} = ${person.id}`);
    expect(rows.map((r) => r.role).toSorted()).toEqual(['admin', 'member']);
  });

  it('ID-4: a person is in a workspace at most once', async () => {
    const person = await user();
    const ws = await workspace();
    await db
      .insert(memberships)
      .values({ workspaceId: ws.id, principalId: person.id, role: 'member' });
    const error = await pgError(
      db.insert(memberships).values({ workspaceId: ws.id, principalId: person.id, role: 'admin' }),
    );
    expect(error).toEqual({ code: UNIQUE, constraint: 'memberships_pkey' });
  });

  it('ID-5, NF-S2: a key can never be a workspace member', async () => {
    const owner = await user();
    const apiKey = await key(owner.id);
    const ws = await workspace();
    const error = await pgError(
      db.insert(memberships).values({ workspaceId: ws.id, principalId: apiKey.id, role: 'admin' }),
    );
    expect(error).toEqual({ code: FOREIGN_KEY, constraint: 'memberships_principal_is_user_fkey' });
  });

  it('ID-5: an api key record belongs to a key principal, one record per key, in one workspace', async () => {
    const owner = await user();
    const apiKey = await key(owner.id);
    const ws = await workspace();
    await db
      .insert(apiKeys)
      .values({ principalId: apiKey.id, workspaceId: ws.id, hash: hash(), prefix: 'lk_abc' });

    const notAKey = await pgError(
      db
        .insert(apiKeys)
        .values({ principalId: owner.id, workspaceId: ws.id, hash: hash(), prefix: 'lk_x' }),
    );
    expect(notAKey).toEqual({ code: FOREIGN_KEY, constraint: 'api_keys_principal_is_key_fkey' });

    const second = await pgError(
      db
        .insert(apiKeys)
        .values({ principalId: apiKey.id, workspaceId: ws.id, hash: hash(), prefix: 'lk_y' }),
    );
    expect(second).toEqual({ code: UNIQUE, constraint: 'api_keys_principal_id_key' });
  });

  it('PR-3: only a SHA-256 hex digest is stored for a key, and digests are unique', async () => {
    const owner = await user();
    const ws = await workspace();
    const plaintext = await pgError(
      db.insert(apiKeys).values({
        principalId: (await key(owner.id)).id,
        workspaceId: ws.id,
        hash: 'lk_live_not_a_digest',
        prefix: 'lk_liv',
      }),
    );
    expect(plaintext).toEqual({ code: CHECK, constraint: 'api_keys_hash_check' });

    const digest = hash();
    await db.insert(apiKeys).values({
      principalId: (await key(owner.id)).id,
      workspaceId: ws.id,
      hash: digest,
      prefix: 'lk_a',
    });
    const duplicate = await pgError(
      db.insert(apiKeys).values({
        principalId: (await key(owner.id)).id,
        workspaceId: ws.id,
        hash: digest,
        prefix: 'lk_b',
      }),
    );
    expect(duplicate).toEqual({ code: UNIQUE, constraint: 'api_keys_hash_key' });
  });

  it('the kind columns used for enforcement cannot be written directly', async () => {
    const owner = await user();
    const ws = await workspace();
    const error = await pgError(
      db.execute(sql`insert into memberships (workspace_id, principal_id, principal_kind, role)
        values (${ws.id}, ${owner.id}, 'key', 'member')`),
    );
    expect(error.code).toBe('428C9');
  });

  it('workspace slugs are unique and URL-safe', async () => {
    const ws = await workspace();
    expect(
      (await pgError(db.insert(workspaces).values({ name: 'dup', slug: ws.slug }))).constraint,
    ).toBe('workspaces_slug_key');
    expect(
      (await pgError(db.insert(workspaces).values({ name: 'bad', slug: 'Not A Slug' }))).constraint,
    ).toBe('workspaces_slug_check');
  });
});

const invite = (overrides: Partial<typeof invites.$inferInsert>) =>
  db.insert(invites).values({
    workspaceId: '',
    role: 'member',
    tokenHash: hash(),
    createdByPrincipalId: '',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });

describe('onboarding schema', () => {
  it('AD-1: instance_setup holds at most one row', async () => {
    const admin = await user({ isInstanceAdmin: true });
    await db.insert(instanceSetup).values({ completedByPrincipalId: admin.id });
    const second = await pgError(
      db.insert(instanceSetup).values({ completedByPrincipalId: admin.id }),
    );
    expect(second).toMatchObject({ code: UNIQUE, constraint: 'instance_setup_pkey' });
    const notTrue = await pgError(
      db.insert(instanceSetup).values({ id: false, completedByPrincipalId: admin.id }),
    );
    expect(notTrue).toMatchObject({ code: CHECK, constraint: 'instance_setup_single_row_check' });
  });

  it('ID-7, NF-S2: an invite is created and accepted by users, never by keys', async () => {
    const ws = await workspace();
    const owner = await user();
    const k = await key(owner.id);
    await invite({ workspaceId: ws.id, createdByPrincipalId: owner.id });
    expect(await pgError(invite({ workspaceId: ws.id, createdByPrincipalId: k.id }))).toMatchObject(
      { code: FOREIGN_KEY, constraint: 'invites_created_by_is_user_fkey' },
    );
    expect(
      await pgError(
        invite({
          workspaceId: ws.id,
          createdByPrincipalId: owner.id,
          acceptedAt: new Date(),
          acceptedByPrincipalId: k.id,
        }),
      ),
    ).toMatchObject({ code: FOREIGN_KEY, constraint: 'invites_accepted_by_is_user_fkey' });
  });

  it('ID-7: an invite stores only a digest, and is never both accepted and revoked', async () => {
    const ws = await workspace();
    const owner = await user();
    expect(
      await pgError(
        invite({ workspaceId: ws.id, createdByPrincipalId: owner.id, tokenHash: 'plain-token' }),
      ),
    ).toMatchObject({ code: CHECK, constraint: 'invites_token_hash_check' });
    expect(
      await pgError(
        invite({
          workspaceId: ws.id,
          createdByPrincipalId: owner.id,
          acceptedAt: new Date(),
          acceptedByPrincipalId: owner.id,
          revokedAt: new Date(),
        }),
      ),
    ).toMatchObject({ code: CHECK, constraint: 'invites_accepted_or_revoked_check' });
    expect(
      await pgError(
        invite({ workspaceId: ws.id, createdByPrincipalId: owner.id, acceptedAt: new Date() }),
      ),
    ).toMatchObject({ code: CHECK, constraint: 'invites_accepted_check' });
  });
});
