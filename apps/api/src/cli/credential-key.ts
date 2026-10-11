import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { ConfigError, DatabaseInUseError, LakkaError } from '@lakka/contracts';
import {
  configureCredentialsFromConfig,
  createLogger,
  credentialKeyBuffers,
  credentialKeyFileName,
  credentialKeyFileVersion,
  ensureDatabaseReady,
  loadProcessConfig,
} from '@lakka/core';
import {
  activeVersionOf,
  countOtherConnections,
  createPool,
  credentialKeyFingerprint,
  readCredentialKeys,
  retireCredentialKeys,
  rotateCredentialValues,
} from '@lakka/db';
import type { Pool } from '@lakka/db';

/*
 * Operator command: rotates the credential master key (NF-S9, ADR 0115).
 *
 *   docker compose stop api worker
 *   docker compose run --rm credential-key rotate
 *   docker compose up -d --wait
 *   docker compose exec api lakka recovery-key
 *   docker compose run --rm credential-key retire
 *   docker compose run --rm credential-key status
 *
 * rotate writes the next key version to the secrets volume first, then in one transaction
 * re-encrypts every encrypted column under it and makes it active. A crash at any point is safe
 * to run again: the transaction either happened or did not, and a key file left by a crash is
 * reused. retire removes older keys once nothing stored needs them. status lists the versions.
 *
 * Nothing here prints or logs a key: `docker compose run` output reaches the logging driver.
 * The new key is read with `lakka recovery-key` through `docker compose exec`.
 *
 * With LAKKA_CREDENTIAL_KEYS set, keys live in the environment, not in files: rotate only
 * re-encrypts to the highest version listed, and retire only records the retirement.
 */

const USAGE = 'usage: lakka credential-key rotate|retire|status\n';
const command = process.argv[2];
if (command !== 'rotate' && command !== 'retire' && command !== 'status') {
  process.stderr.write(USAGE);
  process.exit(64);
}

const config = loadProcessConfig(process.env);
const secretsDir = process.env['LAKKA_SECRETS_DIR'];
// stdout carries what happened; log lines go to stderr.
const { logger } = createLogger({
  level: config.logLevel,
  service: 'credential-key',
  destination: { write: (line: string) => void process.stderr.write(line) },
});
const say = (text: string) => process.stdout.write(`credential-key: ${text}\n`);

/*
 * For the crash-safety integration tests only: stop at a named point until the test kills the
 * process. Unset, which it always is outside those tests, this does nothing.
 */
const PAUSE_AT = process.env['LAKKA_TEST_ROTATE_PAUSE'];
async function checkpoint(point: string): Promise<void> {
  if (PAUSE_AT !== point) return;
  say(`paused at ${point}`);
  await new Promise(() => setInterval(() => undefined, 60_000));
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a key file as init writes secrets: whole or not at all, read-only for everyone, owned by
 * whoever runs this (root in the compose service, like init). It is on disk, and so in the next
 * backup, before any value is encrypted with it.
 */
function writeKeyFile(dir: string, version: number, key: Buffer): void {
  const name = credentialKeyFileName(version);
  const path = join(dir, name);
  if (existsSync(path)) throw new ConfigError(`${name} already exists`);
  const tmp = join(dir, `.${name}.tmp`);
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, 'wx', 0o444);
  try {
    writeSync(fd, key.toString('base64url'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o444);
  renameSync(tmp, path);
  syncDirectory(dir);
}

async function rotate(pool: Pool): Promise<void> {
  const { activeVersion } = await configureCredentialsFromConfig(pool, config);
  const others = await countOtherConnections(pool);
  if (others > 0) throw new DatabaseInUseError(others);
  const keys = credentialKeyBuffers(config);
  const newer = [...keys.keys()].filter((v) => v > activeVersion);
  let target: number;
  if (newer.length > 0) {
    // The environment's highest version, or a key file a crashed rotation left behind.
    target = Math.max(...newer);
  } else if (config.credentials.source === 'env') {
    throw new ConfigError(
      `LAKKA_CREDENTIAL_KEYS has no version above the active v${activeVersion}; add one as ${activeVersion + 1}:<new key>`,
    );
  } else {
    if (secretsDir === undefined) {
      throw new ConfigError('rotate writes the new key to LAKKA_SECRETS_DIR, which is not set');
    }
    const recorded = (await readCredentialKeys(pool)).map((r) => r.version);
    // Never a number used before, even by a retired key whose file is gone.
    target = Math.max(activeVersion, ...recorded, ...keys.keys()) + 1;
    const key = randomBytes(32);
    writeKeyFile(secretsDir, target, key);
    keys.set(target, key);
    say(`wrote ${credentialKeyFileName(target)}`);
  }
  await checkpoint('key-written');
  const { rewritten } = await rotateCredentialValues(pool, {
    keys,
    from: activeVersion,
    to: target,
    afterValue: (n) => checkpoint(`value-${n}`),
  });
  say(`v${target} is active; ${rewritten} stored values were re-encrypted from older versions.`);
  say(
    'start the stack, then save the new recovery key: docker compose exec api lakka recovery-key',
  );
  say(
    'once it is saved and a new backup is taken, remove older keys: docker compose run --rm credential-key retire',
  );
}

async function retire(pool: Pool): Promise<void> {
  const { activeVersion } = await configureCredentialsFromConfig(pool, config);
  const { retired } = await retireCredentialKeys(pool);
  say(
    retired.length > 0
      ? `retired ${retired.map((v) => `v${v}`).join(', ')}; v${activeVersion} is active`
      : `nothing to retire; v${activeVersion} is active`,
  );
  if (config.credentials.source === 'env') {
    const older = [...config.credentials.keys.keys()].filter((v) => v < activeVersion);
    if (older.length > 0) {
      say(`remove ${older.map((v) => `v${v}`).join(', ')} from LAKKA_CREDENTIAL_KEYS`);
    }
    return;
  }
  if (secretsDir === undefined) return;
  // After the database: a crash in between leaves files that the next run removes.
  const removed = readdirSync(secretsDir).filter((name) => {
    const version = credentialKeyFileVersion(name);
    return version !== undefined && version < activeVersion;
  });
  for (const name of removed) unlinkSync(join(secretsDir, name));
  if (removed.length > 0) {
    syncDirectory(secretsDir);
    say(`removed ${removed.join(', ')}`);
  }
}

async function status(pool: Pool): Promise<void> {
  const rows = await readCredentialKeys(pool);
  const keys = credentialKeyBuffers(config);
  const active = activeVersionOf(rows);
  const versions = [...new Set([...rows.map((r) => r.version), ...keys.keys()])].toSorted(
    (a, b) => a - b,
  );
  const lines = [['version', 'state', 'fingerprint', 'key given']];
  for (const version of versions) {
    const row = rows.find((r) => r.version === version);
    const key = keys.get(version);
    const state =
      row === undefined
        ? 'not used yet'
        : row.retiredAt !== null
          ? 'retired'
          : version === active
            ? 'active'
            : row.activatedAt !== null
              ? 'older'
              : 'recorded';
    const given =
      key === undefined
        ? 'no'
        : row !== undefined && credentialKeyFingerprint(key) !== row.keyId
          ? 'differs'
          : 'yes';
    lines.push([`v${version}`, state, row?.keyId.slice(0, 12) ?? '-', given]);
  }
  const widths = lines[0]?.map((_, i) => Math.max(...lines.map((l) => l[i]?.length ?? 0))) ?? [];
  for (const line of lines) {
    process.stdout.write(
      `${line
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd()}\n`,
    );
  }
  if (rows.length === 0) say('no version is recorded yet; v1 is recorded when the api next starts');
  say(
    config.credentials.source === 'env'
      ? 'keys come from LAKKA_CREDENTIAL_KEYS'
      : 'keys come from the secrets directory',
  );
}

const pool = createPool(
  { ...config.database, applicationName: 'lakka-credential-key', max: 1 },
  () => undefined,
);
let exitCode = 0;
try {
  await ensureDatabaseReady(pool, logger, { mode: 'verify' });
  if (command === 'rotate') await rotate(pool);
  else if (command === 'retire') await retire(pool);
  else await status(pool);
} catch (error) {
  // Our own errors name a version, a column or a row id, never a key, so they are safe to show.
  if (error instanceof LakkaError) {
    process.stderr.write(`credential-key: ${error.message} (${error.code})\n`);
  } else logger.error('credential_key.failed', {}, error);
  exitCode = 1;
} finally {
  await pool.end();
}
process.exit(exitCode);
