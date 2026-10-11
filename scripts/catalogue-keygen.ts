import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedKeyOf } from '../packages/core/src/models/feed.ts';

/*
 * Makes an Ed25519 key pair for signing the price feed (PR-6, ADR 0116). Development only, run
 * by the project owner, offline. The private key goes to the path given, mode 0600, and never
 * into the repository: keep it in the password manager and delete the file. The public half
 * and its id are printed, to add to packages/core/src/models/feed-keys.ts in a reviewed commit.
 * Run it twice: a primary key and a backup key, both baked in (docs/releasing.md).
 *
 * Usage: node scripts/catalogue-keygen.ts <private-key-path>
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (target === undefined) {
  process.stderr.write('usage: pnpm catalogue:keygen <private-key-path>\n');
  process.exit(2);
}
// pnpm runs scripts from the repository root; a relative path means where the operator was.
const path = resolve(process.env['INIT_CWD'] ?? process.cwd(), target);
const inside = relative(root, path);
if (inside === '' || !(inside.startsWith('..') || inside.startsWith(sep))) {
  process.stderr.write('refusing to write a private key inside the repository\n');
  process.exit(1);
}

const { privateKey } = generateKeyPairSync('ed25519');
try {
  // 'wx' never overwrites a key that may already be in use.
  writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
    flag: 'wx',
  });
} catch (error) {
  const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
  process.stderr.write(exists ? `${path} already exists\n` : `could not write ${path}\n`);
  process.exit(1);
}
const key = feedKeyOf(privateKey);
process.stdout.write(
  [
    `private key written to ${path} (mode 0600)`,
    'add this to PRODUCTION_FEED_KEYS in packages/core/src/models/feed-keys.ts:',
    `  { keyId: '${key.keyId}', publicKey: '${key.publicKey}' },`,
    '',
  ].join('\n'),
);
