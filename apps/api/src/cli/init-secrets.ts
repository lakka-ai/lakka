import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  EGRESS_KEY_FILE,
  EGRESS_KEYS_DIR,
  SANDBOX_KEYS_DIR,
  TOOL_HOST_TOKEN_FILE,
} from '../sandbox/keys.ts';

/*
 * First-run secret generation (ADR 0004). Runs as the one-shot compose `init` service before
 * Postgres and Valkey start. It writes one file per secret into the shared `secrets` volume and
 * never overwrites an existing one, so restarts keep the same credentials.
 *
 * Secret values are never printed. The only output is which secrets were created.
 */

/**
 * Secrets generated on first run. The credential master key encrypts stored credentials; the
 * setup code lets the operator, and nobody else, complete first-run setup (ADR 0034).
 */
export const SECRETS = [
  'database_password',
  'cache_password',
  'auth_secret',
  'credential_master_key',
  'setup_code',
] as const;

export interface InitResult {
  created: string[];
  existing: string[];
}

export function initSecrets(dir: string, generate: () => string = defaultGenerate): InitResult {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const result: InitResult = { created: [], existing: [] };
  // Once the key has been rotated, credential_master_key holds v1 only until v1 is retired. A
  // fresh random v1 after that would be a key nothing was ever encrypted with (ADR 0115).
  const rotated = readdirSync(dir).some((name) => /^credential_master_key_v[0-9]+$/.test(name));
  for (const name of SECRETS) {
    const path = join(dir, name);
    if (existsSync(path)) {
      result.existing.push(name);
      continue;
    }
    if (name === 'credential_master_key' && rotated) continue;
    writeAtomic(path, generate());
    result.created.push(name);
  }
  // Valkey reads its password from a config file, so derive it from cache_password every run.
  const cachePassword = readFileSync(join(dir, 'cache_password'), 'utf8').trim();
  writeAtomic(join(dir, 'valkey.conf'), `requirepass ${cachePassword}\n`);
  return result;
}

/** The node user and group of the app image, which the api and the egress proxy run as. */
const NODE_GID = 1000;

/**
 * Writes the sandbox's key `name` into `dir` if it is missing (ADR 0118). Unlike the secrets,
 * these are owned root:node with mode 0440, in a directory of mode 0750: the api and the egress
 * proxy read them as the node group, the tool host as root, and a slot's uid in the sandbox
 * cannot. They are not backed up: nothing is encrypted with them, so a lost one is made anew.
 */
export function initSandboxKey(
  dir: string,
  name: string,
  generate: () => string = defaultGenerate,
): 'created' | 'existing' {
  const path = join(dir, name);
  const owned = process.getuid?.() === 0;
  if (owned) chownSync(dir, 0, NODE_GID);
  chmodSync(dir, 0o750);
  if (existsSync(path)) return 'existing';
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, generate(), { mode: 0o440 });
  if (owned) chownSync(tmp, 0, NODE_GID);
  chmodSync(tmp, 0o440);
  renameSync(tmp, path);
  return 'created';
}

function defaultGenerate(): string {
  // 32 bytes, base64url: no characters that need quoting in a connection string or config file.
  return randomBytes(32).toString('base64url');
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o444 });
  // Postgres (uid 999), Valkey (uid 999) and the app (uid 1000) all read these files. The
  // volume is mounted read-only and only into services that need it.
  chmodSync(tmp, 0o444);
  renameSync(tmp, path);
}

function line(label: string, names: string[]): string {
  return names.length > 0 ? `${label}: ${names.join(', ')}\n` : '';
}

function main(): void {
  const dir = process.env['LAKKA_SECRETS_DIR'];
  if (!dir) {
    process.stderr.write('init: LAKKA_SECRETS_DIR is not set\n');
    process.exit(1);
  }
  const { created, existing } = initSecrets(dir);
  // The sandbox's keys, in volumes of their own, mounted here only in the compose stack.
  const keys: string[] = [];
  for (const [keyDir, name] of [
    [SANDBOX_KEYS_DIR, TOOL_HOST_TOKEN_FILE],
    [EGRESS_KEYS_DIR, EGRESS_KEY_FILE],
  ] as const) {
    if (existsSync(keyDir) && initSandboxKey(keyDir, name) === 'created') keys.push(name);
  }
  process.stdout.write(line('init: generated sandbox keys', keys));
  process.stdout.write(
    line('init: generated secrets', created) + line('init: kept existing secrets', existing),
  );
  if (created.length > 0) {
    process.stdout.write(
      'init: secrets live in the "secrets" volume. Include it in backups; losing it loses access to stored credentials.\n',
    );
  }
  if (created.includes('setup_code')) {
    // `pnpm dev` runs the api on this machine, not in a container (`--dev`).
    const command = process.argv.includes('--dev')
      ? 'pnpm setup-code'
      : 'docker compose exec api lakka setup-code';
    process.stdout.write(
      `init: to finish setup, open Lakka in a browser and enter the code from: ${command}\n`,
    );
  }
}

if (import.meta.main) main();
