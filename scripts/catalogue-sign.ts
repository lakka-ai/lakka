import { createPrivateKey } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogueFile } from '../packages/contracts/src/models.ts';
import { feedKeyOf, openFeed, signFeed } from '../packages/core/src/models/feed.ts';
import { PRODUCTION_FEED_KEYS } from '../packages/core/src/models/feed-keys.ts';

/*
 * Signs the bundled catalogue as the price feed (PR-6, ADR 0116): packages/core/catalogue/
 * models.json, with its serial, becomes feed/catalogue-v1.json. Development only, run by the
 * project owner after `pnpm catalogue:update`, in the same pull request. The private key is read
 * from the file LAKKA_FEED_SIGNING_KEY names, never from the repository.
 *
 * The result is checked with the keys baked into this build before it is written, so a feed no
 * release can verify is never published.
 *
 * Usage: LAKKA_FEED_SIGNING_KEY=/path/to/key.pem node scripts/catalogue-sign.ts
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cataloguePath = join(root, 'packages', 'core', 'catalogue', 'models.json');
const outPath = join(root, 'feed', 'catalogue-v1.json');

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const keyPath = process.env['LAKKA_FEED_SIGNING_KEY'];
if (keyPath === undefined || keyPath === '') {
  fail('set LAKKA_FEED_SIGNING_KEY to the path of the private key');
}
const keyFile = resolve(process.env['INIT_CWD'] ?? process.cwd(), keyPath);
if ((statSync(keyFile).mode & 0o077) !== 0) {
  fail('the private key file is readable by others; chmod 600 it first');
}
const privateKey = createPrivateKey(readFileSync(keyFile, 'utf8'));
const { keyId } = feedKeyOf(privateKey);
if (!PRODUCTION_FEED_KEYS.some((k) => k.keyId === keyId)) {
  fail(`key ${keyId} is not in feed-keys.ts, so no release could verify this feed`);
}

const catalogue = catalogueFile.parse(JSON.parse(readFileSync(cataloguePath, 'utf8')) as unknown);
const file = signFeed({ ...catalogue, issuedAt: new Date().toISOString() }, privateKey);
const opened = openFeed(file, PRODUCTION_FEED_KEYS);
if (!opened.ok) fail(`the signed feed does not verify: ${opened.code}`);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, file);
process.stdout.write(
  `feed: serial ${catalogue.serial}, ${catalogue.models.length} models, signed by ${keyId}\n`,
);
