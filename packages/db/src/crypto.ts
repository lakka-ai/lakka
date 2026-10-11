import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { customType } from 'drizzle-orm/pg-core';
import { ConfigError, CredentialKeyUnavailableError } from '@lakka/contracts';

/*
 * Credential encryption at rest (PR-2, NF-S1, ADR 0032). AES-256-GCM with a master key that
 * comes from the environment or the secrets volume and is never stored in the database.
 *
 * Stored format: "v<N>:" + base64url(12-byte IV) + ":" + base64url(ciphertext and 16-byte tag).
 * The column's identity is bound in as associated data, so a ciphertext copied into another
 * column fails to decrypt. The prefix names the key version: values are decrypted with the key
 * they name and always written with the active one, so the key can be rotated (NF-S9, ADR 0115).
 * "v1" is the original key, as it was before rotation existed, so no stored value had to change.
 *
 * The key ring is configured once per process at startup, after the database said which version
 * is active. Until then, reading or writing an encrypted column throws: nothing is ever stored
 * in the clear by accident.
 */

export interface CredentialKeyRing {
  /** The version every write uses. */
  active: number;
  /** Every key this process was given, by version; 32 bytes each. */
  keys: ReadonlyMap<number, Buffer>;
}

const PREFIX = /^v([1-9][0-9]{0,8})$/;
let ring: CredentialKeyRing | undefined;

/** Decodes a base64url key, refusing anything that is not 32 bytes. Never echoes the key. */
export function decodeCredentialKey(base64urlKey: string, version = 1): Buffer {
  const decoded = Buffer.from(base64urlKey, 'base64url');
  if (decoded.length !== 32) {
    throw new ConfigError(
      `invalid configuration: credential key v${version} must be 32 bytes, base64url`,
    );
  }
  return decoded;
}

export function configureCredentialKeys(next: CredentialKeyRing): void {
  if (!Number.isInteger(next.active) || next.active < 1 || !next.keys.has(next.active)) {
    throw new ConfigError(`credential key v${next.active} is active but was not given`);
  }
  for (const [version, key] of next.keys) {
    if (!Number.isInteger(version) || version < 1 || key.length !== 32) {
      throw new ConfigError(
        `invalid configuration: credential key v${version} must be 32 bytes, base64url`,
      );
    }
  }
  ring = { active: next.active, keys: new Map(next.keys) };
}

/** A ring of just the original key, for tests and tools that only ever had one. */
export function configureCredentialKey(base64urlKey: string): void {
  configureCredentialKeys({ active: 1, keys: new Map([[1, decodeCredentialKey(base64urlKey)]]) });
}

function configured(): CredentialKeyRing {
  if (ring === undefined) {
    throw new ConfigError('the credential master key is not configured');
  }
  return ring;
}

/** The version writes use now. */
export function activeCredentialKeyVersion(): number {
  return configured().active;
}

/**
 * Identifies a key without revealing it: an HMAC of a fixed label under the key. Postgres keeps
 * this per version, so a process given the wrong key refuses to start instead of writing
 * values nobody can read later.
 */
export function credentialKeyFingerprint(key: Buffer): string {
  return createHmac('sha256', key).update('lakka credential key fingerprint').digest('hex');
}

/** The key version a stored value names, or undefined if it is not in the stored format. */
export function credentialVersionOf(stored: string): number | undefined {
  const match = PREFIX.exec(stored.slice(0, stored.indexOf(':')));
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function encryptWithRing(
  keys: CredentialKeyRing,
  plaintext: string,
  context: string,
): string {
  const key = keys.keys.get(keys.active);
  if (key === undefined) throw new CredentialKeyUnavailableError(keys.active);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `v${keys.active}:${iv.toString('base64url')}:${body.toString('base64url')}`;
}

export function decryptWithRing(keys: CredentialKeyRing, stored: string, context: string): string {
  const [, ivPart, bodyPart, extra] = stored.split(':');
  const version = credentialVersionOf(stored);
  if (
    version === undefined ||
    ivPart === undefined ||
    bodyPart === undefined ||
    extra !== undefined
  ) {
    throw new Error('unrecognized credential format');
  }
  const key = keys.keys.get(version);
  if (key === undefined) throw new CredentialKeyUnavailableError(version);
  const body = Buffer.from(bodyPart, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptCredential(plaintext: string, context: string): string {
  return encryptWithRing(configured(), plaintext, context);
}

export function decryptCredential(stored: string, context: string): string {
  return decryptWithRing(configured(), stored, context);
}

export interface EncryptedColumn {
  table: string;
  column: string;
  /** The associated data: "table.column". */
  context: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const registry = new Map<string, EncryptedColumn>();

/**
 * Every encrypted column, registered as the schema is loaded. Rotation re-encrypts from this
 * list, so it never depends on a hand-kept one; a unit test checks it against the schema.
 */
export function encryptedColumns(): EncryptedColumn[] {
  return [...registry.values()];
}

/** A text column encrypted at rest. `context` identifies the column, e.g. "sso_providers.oidc_config". */
export function encryptedText(name: string, context: string) {
  const [table, column, extra] = context.split('.');
  if (
    table === undefined ||
    column !== name ||
    extra !== undefined ||
    !IDENTIFIER.test(table) ||
    !IDENTIFIER.test(column)
  ) {
    // A programming error, caught as the schema loads: the context is the column's identity.
    throw new Error(`encrypted column ${name} needs the context "<table>.${name}"`);
  }
  registry.set(context, { table, column, context });
  return customType<{ data: string; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value) => encryptCredential(value, context),
    fromDriver: (value) => decryptCredential(value, context),
  })(name);
}
