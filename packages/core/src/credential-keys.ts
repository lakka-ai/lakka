import { CredentialKeyMissingError } from '@lakka/contracts';
import { configureCredentialKeys, decodeCredentialKey, prepareCredentialKeyRing } from '@lakka/db';
import type { Pool } from '@lakka/db';
import type { Config } from './config.ts';

/*
 * Every process that reads or writes encrypted credentials configures its keys here, once, at
 * startup, after the schema is ready (NF-S1, NF-S9, ADR 0115): the api, the worker, and the
 * commands that touch credentials. Postgres says which version is active; the config only
 * supplies keys. A process missing the active key, or given a key that is not the one recorded
 * for its version, refuses to start with a typed error that names the version, never the key.
 */

/** Decodes the configured keys, refusing any that is not 32 bytes. */
export function credentialKeyBuffers(config: Config): Map<number, Buffer> {
  return new Map(
    [...config.credentials.keys].map(([version, key]) => [
      version,
      decodeCredentialKey(key, version),
    ]),
  );
}

export interface ConfiguredCredentials {
  activeVersion: number;
  /** The active key, base64url: shown as the recovery key at setup and by `recovery-key`. */
  activeKey: string;
}

export async function configureCredentialsFromConfig(
  pool: Pool,
  config: Config,
): Promise<ConfiguredCredentials> {
  if (config.credentials.keys.size === 0) throw new CredentialKeyMissingError(1);
  const ring = await prepareCredentialKeyRing(pool, credentialKeyBuffers(config));
  configureCredentialKeys(ring);
  const activeKey = config.credentials.keys.get(ring.active);
  // prepareCredentialKeyRing refuses a ring without its active version.
  if (activeKey === undefined) throw new CredentialKeyMissingError(ring.active);
  return { activeVersion: ring.active, activeKey };
}
