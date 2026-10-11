import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { CredentialKeyMismatchError, CredentialKeyMissingError } from '@lakka/contracts';
import type { WorkspaceView } from '@lakka/contracts';
import { configureCredentialsFromConfig, loadConfig, loadProcessConfig } from '@lakka/core';
import {
  createDb,
  createPool,
  credentialVersionOf,
  decodeCredentialKey,
  decryptWithRing,
  encryptedColumnTargets,
  encryptWithRing,
  findOlderCredentialValues,
  readCredentialKeys,
  schema,
} from '@lakka/db';
import type { Pool } from '@lakka/db';
import { POSTGRES_ADMIN_URL } from '../../../test/integration/context.ts';
import { as, CREDENTIAL_KEY, createTestApp, signedInUser } from './support.ts';
import type { TestApp } from './support.ts';

/*
 * Rotating the credential master key (NF-S9, ADR 0115) against real Postgres: every encrypted
 * column is seeded through the services that write it, then the real `lakka credential-key`
 * command runs as its own process, as the compose service runs it. Crash safety is shown by
 * killing that process at a pause point the command offers to tests only.
 */

const CLI = fileURLToPath(new URL('../src/cli/credential-key.ts', import.meta.url));
const RECOVERY = fileURLToPath(new URL('../src/cli/recovery-key.ts', import.meta.url));
const V1 = decodeCredentialKey(CREDENTIAL_KEY);

interface Seeded {
  t: TestApp;
  /** The secrets directory, holding credential_master_key as init wrote it. */
  dir: string;
  /** Every stored credential as plaintext, by "table.column:row id". */
  plaintext: Map<string, string>;
  providerId: string;
}

let current: Seeded | undefined;
afterEach(async () => {
  if (current === undefined) return;
  current.t.cache.close();
  await current.t.database.drop();
  current = undefined;
});

/** A short-lived connection, closed before the command runs, which needs the database to itself. */
async function withPool<T>(seeded: Seeded, fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = createPool({ ...seeded.t.database.options(), max: 1 }, () => undefined);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
    await quiet(seeded);
  }
}

/** Waits until nothing is connected to the test database, from the maintenance database. */
async function quiet(seeded: Seeded): Promise<void> {
  const url = new URL(inject(POSTGRES_ADMIN_URL));
  const admin = createPool(
    {
      host: url.hostname,
      port: Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      applicationName: 'lakka-tests-quiet',
      max: 1,
    },
    () => undefined,
  );
  try {
    await expect
      .poll(
        async () =>
          (
            await admin.query<{ n: number }>(
              `select count(*)::int as n from pg_stat_activity
               where datname = $1 and backend_type = 'client backend'`,
              [seeded.t.database.name],
            )
          ).rows[0]?.n,
        { timeout: 10_000, interval: 50 },
      )
      .toBe(0);
  } finally {
    await admin.end();
  }
}

function childEnv(seeded: Seeded, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const db = seeded.t.database.options();
  return {
    PATH: process.env['PATH'],
    LAKKA_LOG_LEVEL: 'warn',
    LAKKA_SECRETS_DIR: seeded.dir,
    LAKKA_DATABASE_HOST: db.host,
    LAKKA_DATABASE_PORT: String(db.port),
    LAKKA_DATABASE_USER: db.user,
    LAKKA_DATABASE_PASSWORD: db.password,
    LAKKA_DATABASE_NAME: db.database,
    ...extra,
  };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function start(
  seeded: Seeded,
  script: string,
  args: string[],
  extra: Record<string, string> = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [script, ...args], { env: childEnv(seeded, extra) });
}

async function run(
  seeded: Seeded,
  args: string[],
  extra: Record<string, string> = {},
  script = CLI,
  /** Waits for its connection to go; off while a test holds one open itself. */
  thenQuiet = true,
): Promise<Run> {
  const child = start(seeded, script, args, extra);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  if (thenQuiet) await quiet(seeded);
  return { code, stdout, stderr };
}

/** Runs rotate until it pauses at `point`, then kills it as a power cut would. */
async function killAt(seeded: Seeded, point: string): Promise<void> {
  const child = start(seeded, CLI, ['rotate'], { LAKKA_TEST_ROTATE_PAUSE: point });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes(`paused at ${point}`)) resolve();
    });
    child.on('exit', (code) => reject(new Error(`rotate exited with ${code} first: ${stderr}`)));
  });
  child.kill('SIGKILL');
  await exited;
  // Postgres rolls the killed session's transaction back as the connection drops.
  await quiet(seeded);
}

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Every stored encrypted value, raw, by "table.column:row id". */
async function rawValues(pool: Pool): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  for (const target of encryptedColumnTargets()) {
    const result = await pool.query<{ id: string; value: string }>(
      `select "${target.primaryKey}"::text as id, "${target.column}" as value
       from "${target.table}" where "${target.column}" is not null`,
    );
    for (const row of result.rows) values.set(`${target.context}:${row.id}`, row.value);
  }
  return values;
}

function decryptAll(values: Map<string, string>, keys: Map<number, Buffer>): Map<string, string> {
  const ring = { active: Math.max(...keys.keys()), keys };
  return new Map(
    [...values].map(([where, value]) => [
      where,
      decryptWithRing(ring, value, where.slice(0, where.indexOf(':'))),
    ]),
  );
}

const versions = (values: Map<string, string>) =>
  [...new Set([...values.values()].map(credentialVersionOf))].toSorted();

/** Checks that startup refused with this error, for this version. */
async function expectRefusal(
  promise: Promise<unknown>,
  type: typeof CredentialKeyMissingError | typeof CredentialKeyMismatchError,
  version: number,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  expect(error).toMatchObject({ version });
}

/** One value in every encrypted column, each written the way the product writes it. */
async function seed(): Promise<Seeded> {
  const t = await createTestApp();
  const tag = randomBytes(4).toString('hex');
  const root = await signedInUser(t, 'Root');
  await t.pool.query('update principals set is_instance_admin = true where id = $1', [
    root.principal.id,
  ]);
  const ws = (
    (
      await as(t, root).post('/api/workspaces', { name: `Keys ${tag}`, slug: `keys-${tag}` })
    ).json() as { workspace: WorkspaceView }
  ).workspace;
  const provider = await as(t, root).post('/api/providers', {
    kind: 'anthropic',
    apiKey: `sk-ant-${tag}-instance`,
  });
  expect(provider.statusCode).toBe(201);
  const providerId = (provider.json() as { provider: { id: string } }).provider.id;
  expect(
    (
      await as(t, root).post(`/api/workspaces/${ws.id}/providers`, {
        kind: 'openai',
        apiKey: `sk-${tag}-workspace`,
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (await as(t, root).put('/api/budgets/webhook', { url: 'https://hooks.example.com/budget' }))
      .statusCode,
  ).toBeLessThan(300);
  const [server] = await t.db
    .insert(schema.mcpServers)
    .values({
      workspaceId: ws.id,
      name: `oauth-${tag}`,
      transport: 'streamable_http',
      url: `https://mcp-${tag}.example.com/mcp`,
      authMode: 'oauth',
      oauthClient: JSON.stringify({ clientId: 'lakka', clientSecret: `client-${tag}` }),
      oauthClientSource: 'admin',
      createdByPrincipalId: root.principal.id,
    })
    .returning({ id: schema.mcpServers.id });
  if (server === undefined) throw new Error('no server');
  await t.db.insert(schema.mcpCredentials).values({
    mcpServerId: server.id,
    principalId: root.principal.id,
    kind: 'user',
    secret: `access-${tag}`,
    refreshSecret: `refresh-${tag}`,
  });
  await t.db.insert(schema.mcpOauthStates).values({
    stateHash: createHash('sha256').update(tag).digest('hex'),
    mcpServerId: server.id,
    workspaceId: ws.id,
    principalId: root.principal.id,
    codeVerifier: `verifier-${tag}`,
    expiresAt: new Date(Date.now() + 600_000),
  });
  await t.db.insert(schema.ssoProviders).values({
    id: `sso-${tag}`,
    issuer: `https://idp-${tag}.example.com`,
    providerId: `idp-${tag}`,
    domain: 'example.com',
    oidcConfig: JSON.stringify({ clientId: 'lakka', clientSecret: `oidc-${tag}` }),
  });
  await t.db.update(schema.authAccounts).set({ idToken: `id-token-${tag}` });

  const plaintext = decryptAll(await rawValues(t.pool), new Map([[1, V1]]));
  // The app is done; the command needs the database to itself.
  await t.app.close();
  await t.tracing.shutdown();
  await t.database.endPools();

  const dir = mkdtempSync(join(tmpdir(), 'lakka-keys-'));
  writeFileSync(join(dir, 'credential_master_key'), CREDENTIAL_KEY, { mode: 0o444 });
  current = { t, dir, plaintext, providerId };
  await quiet(current);
  return current;
}

describe('rotating the credential master key (NF-S9, ADR 0115)', () => {
  it('NF-S9: rotation re-encrypts all registered columns, seeded through the real services; every credential reads afterwards; no old-version value is left in any text column', async () => {
    const s = await seed();
    const columns = new Set([...s.plaintext.keys()].map((k) => k.slice(0, k.indexOf(':'))));
    expect([...columns].toSorted()).toEqual(
      encryptedColumnTargets()
        .map((c) => c.context)
        .toSorted(),
    );

    const rotated = await run(s, ['rotate']);
    expect(rotated.stderr).toBe('');
    expect(rotated.code).toBe(0);
    const file = join(s.dir, 'credential_master_key_v2');
    const v2 = readFileSync(file, 'utf8');
    expect(statSync(file).mode & 0o777).toBe(0o444);
    // The command never shows a key: its output reaches the logging driver.
    for (const key of [CREDENTIAL_KEY, v2]) {
      expect(rotated.stdout).not.toContain(key);
    }

    await withPool(s, async (pool) => {
      const raw = await rawValues(pool);
      expect(versions(raw)).toEqual([2]);
      // Every value reads with v2 alone and is what was stored.
      expect(decryptAll(raw, new Map([[2, decodeCredentialKey(v2, 2)]]))).toEqual(s.plaintext);
      expect(await findOlderCredentialValues(pool, 2)).toEqual([]);
      const keys = await readCredentialKeys(pool);
      expect(keys.map((k) => [k.version, k.activatedAt !== null, k.retiredAt])).toEqual([
        [1, true, null],
        [2, true, null],
      ]);

      // A process started from the same secrets reads through the schema as the services do.
      const configured = await configureCredentialsFromConfig(
        pool,
        loadProcessConfig({ LAKKA_SECRETS_DIR: s.dir }),
      );
      expect(configured).toEqual({ activeVersion: 2, activeKey: v2 });
      const db = createDb(pool);
      const provider = (await db.select().from(schema.providerConfigs)).find(
        (p) => p.id === s.providerId,
      );
      expect(provider?.apiKey).toBe(s.plaintext.get(`provider_configs.api_key:${s.providerId}`));
      expect(await db.select().from(schema.alertWebhooks)).toHaveLength(1);
      expect(await db.select().from(schema.mcpCredentials)).toHaveLength(1);
    });

    // The recovery key is now v2's, printed to the command's own output only.
    const recovery = await run(s, [], {}, RECOVERY);
    expect(recovery).toMatchObject({ code: 0, stdout: `${v2}\n` });

    // Retired, v1's file goes; v2 alone starts.
    const retired = await run(s, ['retire']);
    expect(retired.code).toBe(0);
    expect(retired.stdout).toContain('retired v1');
    expect(existsSync(join(s.dir, 'credential_master_key'))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(v2);
    const status = await run(s, ['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/v1\s+retired\s+[0-9a-f]{12}\s+no/);
    expect(status.stdout).toMatch(/v2\s+active\s+[0-9a-f]{12}\s+yes/);
    expect(status.stdout).not.toContain(v2);
    await withPool(s, async (pool) => {
      const configured = await configureCredentialsFromConfig(
        pool,
        loadProcessConfig({ LAKKA_SECRETS_DIR: s.dir }),
      );
      expect(configured.activeVersion).toBe(2);
      expect((await readCredentialKeys(pool))[0]?.retiredAt).not.toBeNull();
    });
  });

  it.each(['key-written', 'value-3'])(
    'NF-S9: a rotation killed at %s changes nothing, and a rerun reuses the same key file and completes',
    async (point) => {
      const s = await seed();
      const before = await withPool(s, rawValues);
      await killAt(s, point);

      const file = join(s.dir, 'credential_master_key_v2');
      expect(existsSync(file)).toBe(true);
      const written = digest(file);
      await withPool(s, async (pool) => {
        // The transaction never committed: every value and the active version are as they were.
        expect(await rawValues(pool)).toEqual(before);
        expect((await readCredentialKeys(pool)).map((k) => k.version)).toEqual([1]);
      });
      // Started again as things are, with the leftover key file, everything still reads with v1.
      await withPool(s, async (pool) => {
        const configured = await configureCredentialsFromConfig(
          pool,
          loadProcessConfig({ LAKKA_SECRETS_DIR: s.dir }),
        );
        expect(configured.activeVersion).toBe(1);
      });

      const rerun = await run(s, ['rotate']);
      expect(rerun.code).toBe(0);
      expect(rerun.stdout).not.toContain('wrote');
      expect(digest(file)).toBe(written);
      expect(existsSync(join(s.dir, 'credential_master_key_v3'))).toBe(false);
      await withPool(s, async (pool) => {
        const raw = await rawValues(pool);
        expect(versions(raw)).toEqual([2]);
        const v2 = decodeCredentialKey(readFileSync(file, 'utf8'), 2);
        expect(decryptAll(raw, new Map([[2, v2]]))).toEqual(s.plaintext);
      });
    },
  );

  it('NF-S9: a corrupt row aborts the rotation with nothing changed, naming the column and row id', async () => {
    const s = await seed();
    // A value in the stored format that the v1 key cannot open.
    const corrupt = encryptWithRing(
      { active: 1, keys: new Map([[1, randomBytes(32)]]) },
      'whatever',
      'provider_configs.api_key',
    );
    const before = await withPool(s, async (pool) => {
      await pool.query('update provider_configs set api_key = $1 where id = $2', [
        corrupt,
        s.providerId,
      ]);
      return rawValues(pool);
    });
    const rotated = await run(s, ['rotate']);
    expect(rotated.code).toBe(1);
    expect(rotated.stderr).toContain('provider_configs.api_key');
    expect(rotated.stderr).toContain(s.providerId);
    expect(rotated.stderr).toContain('credential_unreadable');
    await withPool(s, async (pool) => {
      expect(await rawValues(pool)).toEqual(before);
      expect((await readCredentialKeys(pool)).map((k) => k.version)).toEqual([1]);
    });
  });

  it('NF-S9: rotate refuses while another application connection is open', async () => {
    const s = await seed();
    const api = createPool(
      { ...s.t.database.options(), applicationName: 'lakka-api', max: 1 },
      () => undefined,
    );
    const held = await api.connect();
    try {
      const rotated = await run(s, ['rotate'], {}, CLI, false);
      expect(rotated.code).toBe(1);
      expect(rotated.stderr).toContain('database_in_use');
      // Refused before anything was written.
      expect(existsSync(join(s.dir, 'credential_master_key_v2'))).toBe(false);
    } finally {
      held.release();
      await api.end();
      await quiet(s);
    }
    expect((await run(s, ['rotate'])).code).toBe(0);
  });

  it('NF-S9: retire refuses while a row is on an old version', async () => {
    const s = await seed();
    const before = await withPool(s, rawValues);
    expect((await run(s, ['rotate'])).code).toBe(0);
    const old = before.get(`provider_configs.api_key:${s.providerId}`) ?? '';
    expect(credentialVersionOf(old)).toBe(1);

    // An encrypted column put back on v1, as a process still running with v1 would write it.
    const rotatedValue = await withPool(s, async (pool) => {
      const { rows } = await pool.query<{ api_key: string }>(
        'select api_key from provider_configs where id = $1',
        [s.providerId],
      );
      await pool.query('update provider_configs set api_key = $1 where id = $2', [
        old,
        s.providerId,
      ]);
      return rows[0]?.api_key ?? '';
    });
    let retired = await run(s, ['retire']);
    expect(retired.code).toBe(1);
    expect(retired.stderr).toContain('provider_configs.api_key (1)');
    expect(retired.stderr).toContain('credential_key_in_use');
    expect(existsSync(join(s.dir, 'credential_master_key'))).toBe(true);

    // A v1 value anywhere else in the schema holds the key back too.
    await withPool(s, async (pool) => {
      await pool.query('update provider_configs set api_key = $1 where id = $2', [
        rotatedValue,
        s.providerId,
      ]);
      await pool.query('update workspaces set name = $1', [old]);
    });
    retired = await run(s, ['retire']);
    expect(retired.code).toBe(1);
    expect(retired.stderr).toContain('workspaces.name');
    await withPool(s, async (pool) => {
      expect((await readCredentialKeys(pool)).every((k) => k.retiredAt === null)).toBe(true);
      await pool.query(`update workspaces set name = 'Back'`);
    });

    retired = await run(s, ['retire']);
    expect(retired.code).toBe(0);
    expect(existsSync(join(s.dir, 'credential_master_key'))).toBe(false);
  });

  it('NF-S9: startup refuses when the ring lacks the active key or its fingerprint differs', async () => {
    const s = await seed();
    const other = randomBytes(32).toString('base64url');
    // Before any rotation: a wrong original key is never recorded as right.
    await withPool(s, async (pool) => {
      await pool.query('delete from credential_keys');
      await expectRefusal(
        configureCredentialsFromConfig(pool, loadConfig({ LAKKA_CREDENTIAL_KEY: other })),
        CredentialKeyMismatchError,
        1,
      );
      expect(await readCredentialKeys(pool)).toEqual([]);
    });
    expect((await run(s, ['rotate'])).code).toBe(0);
    const v2 = readFileSync(join(s.dir, 'credential_master_key_v2'), 'utf8');

    await withPool(s, async (pool) => {
      // v1 alone: the active v2 is missing.
      await expectRefusal(
        configureCredentialsFromConfig(pool, loadConfig({ LAKKA_CREDENTIAL_KEY: CREDENTIAL_KEY })),
        CredentialKeyMissingError,
        2,
      );
      // A different key given as v2, and one given as v1.
      await expectRefusal(
        configureCredentialsFromConfig(
          pool,
          loadConfig({ LAKKA_CREDENTIAL_KEYS: `1:${CREDENTIAL_KEY},2:${other}` }),
        ),
        CredentialKeyMismatchError,
        2,
      );
      await expectRefusal(
        configureCredentialsFromConfig(
          pool,
          loadConfig({ LAKKA_CREDENTIAL_KEYS: `1:${other},2:${v2}` }),
        ),
        CredentialKeyMismatchError,
        1,
      );
      // The environment form with the right keys starts.
      expect(
        await configureCredentialsFromConfig(
          pool,
          loadConfig({ LAKKA_CREDENTIAL_KEYS: `2:${v2}` }),
        ),
      ).toEqual({ activeVersion: 2, activeKey: v2 });
    });

    // The commands refuse the same way, naming the version and never a key.
    const refused = await run(s, [], { LAKKA_CREDENTIAL_KEYS: `1:${CREDENTIAL_KEY}` }, RECOVERY);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('credential_key_missing');
    expect(refused.stderr).toContain('v2');
    expect(refused.stderr).not.toContain(CREDENTIAL_KEY);
  });
});
