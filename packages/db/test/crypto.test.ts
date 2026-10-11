import { randomBytes } from 'node:crypto';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, CredentialKeyUnavailableError } from '@lakka/contracts';
import {
  configureCredentialKey,
  configureCredentialKeys,
  credentialKeyFingerprint,
  credentialVersionOf,
  decryptCredential,
  encryptCredential,
  encryptedColumns,
} from '../src/crypto.ts';
import { encryptedColumnTargets } from '../src/queries/credential-keys.ts';
import * as schema from '../src/schema/index.ts';

const newKey = () => randomBytes(32).toString('base64url');
const SECRET = 'client-secret-7c1f9a';

describe('credential encryption (PR-2, NF-S1)', () => {
  beforeEach(() => configureCredentialKey(newKey()));

  it('round-trips, and the stored value never contains the plaintext', () => {
    const stored = encryptCredential(SECRET, 'test.column');
    expect(stored).toMatch(/^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain(SECRET);
    expect(decryptCredential(stored, 'test.column')).toBe(SECRET);
  });

  it('uses a fresh IV every time', () => {
    expect(encryptCredential(SECRET, 'c')).not.toBe(encryptCredential(SECRET, 'c'));
  });

  it('detects tampering', () => {
    const stored = encryptCredential(SECRET, 'c');
    const last = stored.at(-1) === 'A' ? 'B' : 'A';
    expect(() => decryptCredential(`${stored.slice(0, -1)}${last}`, 'c')).toThrow(
      /unable to authenticate/,
    );
  });

  it('refuses a ciphertext moved to another column', () => {
    const stored = encryptCredential(SECRET, 'sso_providers.oidc_config');
    expect(() => decryptCredential(stored, 'other.column')).toThrow(/unable to authenticate/);
  });

  it('fails with the wrong key', () => {
    const stored = encryptCredential(SECRET, 'c');
    configureCredentialKey(newKey());
    expect(() => decryptCredential(stored, 'c')).toThrow(/unable to authenticate/);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => configureCredentialKey(randomBytes(16).toString('base64url'))).toThrow(
      ConfigError,
    );
  });
});

describe('credential key versions (NF-S1, NF-S9)', () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);

  it('NF-S1: a v1 ciphertext decrypts with a v1 and v2 ring; writes use v2', () => {
    configureCredentialKey(k1.toString('base64url'));
    const old = encryptCredential(SECRET, 'c');
    expect(credentialVersionOf(old)).toBe(1);
    configureCredentialKeys({
      active: 2,
      keys: new Map([
        [1, k1],
        [2, k2],
      ]),
    });
    expect(decryptCredential(old, 'c')).toBe(SECRET);
    const fresh = encryptCredential(SECRET, 'c');
    expect(fresh).toMatch(/^v2:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    expect(decryptCredential(fresh, 'c')).toBe(SECRET);
    // Without v1, only the v2 value still reads.
    configureCredentialKeys({ active: 2, keys: new Map([[2, k2]]) });
    expect(decryptCredential(fresh, 'c')).toBe(SECRET);
    expect(() => decryptCredential(old, 'c')).toThrow(CredentialKeyUnavailableError);
  });

  it('NF-S1: an unknown version fails with a typed error naming it', () => {
    configureCredentialKeys({ active: 2, keys: new Map([[2, k2]]) });
    const stored = encryptCredential(SECRET, 'c').replace(/^v2:/, 'v7:');
    let caught: unknown;
    try {
      decryptCredential(stored, 'c');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialKeyUnavailableError);
    expect(caught).toMatchObject({ code: 'credential_key_unavailable', version: 7 });
    expect(String(caught)).toContain('v7');
    expect(() => decryptCredential(stored.replace(/^v7:/, 'v0:'), 'c')).toThrow(
      /unrecognized credential format/,
    );
  });

  it('NF-S1: rewriting the prefix to another version fails authentication', () => {
    configureCredentialKeys({
      active: 2,
      keys: new Map([
        [1, k1],
        [2, k2],
      ]),
    });
    const stored = encryptCredential(SECRET, 'c');
    expect(() => decryptCredential(stored.replace(/^v2:/, 'v1:'), 'c')).toThrow(
      /unable to authenticate/,
    );
  });

  it('NF-S9: a ring must hold its active key, and every key must be 32 bytes', () => {
    expect(() => configureCredentialKeys({ active: 3, keys: new Map([[2, k2]]) })).toThrow(
      ConfigError,
    );
    expect(() =>
      configureCredentialKeys({ active: 2, keys: new Map([[2, randomBytes(16)]]) }),
    ).toThrow(ConfigError);
    // A fingerprint identifies a key without being it.
    expect(credentialKeyFingerprint(k1)).toMatch(/^[0-9a-f]{64}$/);
    expect(credentialKeyFingerprint(k1)).not.toBe(credentialKeyFingerprint(k2));
    expect(credentialKeyFingerprint(k1)).not.toContain(k1.toString('hex'));
  });

  it('NF-S1: every encrypted column is registered', () => {
    configureCredentialKey(k1.toString('base64url'));
    // An encrypted column is one whose driver value comes out in the stored format.
    const inSchema: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      for (const column of config.columns) {
        if (column.columnType !== 'PgCustomColumn') continue;
        let driver: unknown;
        try {
          driver = column.mapToDriverValue('probe');
        } catch {
          continue;
        }
        if (typeof driver === 'string' && credentialVersionOf(driver) !== undefined) {
          inSchema.push(`${config.name}.${column.name}`);
        }
      }
    }
    const registered = encryptedColumns().map((c) => c.context);
    expect(registered.toSorted()).toEqual(inSchema.toSorted());
    expect(registered.toSorted()).toEqual([
      'alert_webhooks.secret',
      'auth_accounts.id_token',
      'mcp_credentials.refresh_secret',
      'mcp_credentials.secret',
      'mcp_oauth_states.code_verifier',
      'mcp_servers.oauth_client',
      'provider_configs.api_key',
      'sso_providers.oidc_config',
    ]);
    // Rotation can rewrite each one by its row's primary key.
    expect(
      encryptedColumnTargets()
        .map((t) => t.primaryKey)
        .toSorted(),
    ).toEqual(['id', 'id', 'id', 'id', 'id', 'id', 'id', 'state_hash']);
  });
});
