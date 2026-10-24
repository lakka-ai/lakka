import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { tarStream } from '../packages/core/src/export/tar.ts';

/*
 * The release bundle (NF-D4, ADR 0086): what a customer downloads and runs `docker compose up`
 * in. The repository's compose files build from source; the bundle's name published images,
 * each pinned by digest, and build nothing. Everything else is the repository's own file.
 *
 *   pnpm release:bundle --version v1.0.0 --out dist/release \
 *     --image lakka/app:local=ghcr.io/lakka-ai/lakka@sha256:... \
 *     --image lakka/caddy:local=ghcr.io/lakka-ai/lakka-caddy@sha256:... \
 *     --image pgvector/pgvector:0.8.7-pg18-trixie=pgvector/pgvector:0.8.7-pg18-trixie@sha256:...
 *
 * Every image the compose file names must be mapped, so a release never ships a tag that could
 * change under it, and never the local build tags.
 *
 * Writes <out>/lakka-<version>.tar.gz and its .sha256.
 */

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    out: { type: 'string', default: 'dist/release' },
    image: { type: 'string', multiple: true, default: [] },
    // For tests: map to tags instead of digests.
    'allow-tags': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(`release-bundle: ${message}\n`);
  process.exit(1);
}

const version = values.version ?? fail('--version is required');
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail('--version must look like v1.2.3');
const images = new Map<string, string>();
for (const pair of values.image) {
  const at = pair.indexOf('=');
  if (at <= 0) fail(`--image takes from=to, got ${pair}`);
  const to = pair.slice(at + 1);
  if (!values['allow-tags'] && !/@sha256:[0-9a-f]{64}$/.test(to)) {
    fail(`${to} is not pinned by digest`);
  }
  images.set(pair.slice(0, at), to);
}

const IMAGE_LINE = /^(\s*image:\s*(?:&[\w-]+\s+)?)(\S+)\s*$/;

/** The repository's compose file with each image replaced and every build section removed. */
function bundleCompose(source: string, mapping: ReadonlyMap<string, string>): string {
  const lines = source.split('\n');
  const out: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const build = /^(\s*)build:\s*$/.exec(line);
    if (build !== null) {
      // Skip the section: every following line indented deeper than `build:`.
      const indent = build[1]?.length ?? 0;
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? '';
        if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
        i += 1;
      }
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image !== null && !(image[2] ?? '').startsWith('*')) {
      const from = image[2] ?? '';
      const to = mapping.get(from);
      if (to === undefined) fail(`no --image for ${from}`);
      used.add(from);
      out.push(`${image[1]}${to}`);
      continue;
    }
    out.push(line);
  }
  for (const from of mapping.keys())
    if (!used.has(from)) fail(`${from} is not in the compose file`);
  const text = out.join('\n');
  if (/^\s*build:/m.test(text) || /:local\b/.test(text)) fail('a build or a local image is left');
  return text;
}

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const name = `lakka-${version}`;
const out = values.out;
const stage = join(out, name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'docker'), { recursive: true });
mkdirSync(join(stage, 'backups'), { recursive: true });

const header = `# Lakka ${version}, from the release bundle: every image pinned by digest, nothing built.\n`;
writeFileSync(
  join(stage, 'docker', 'compose.yaml'),
  header + bundleCompose(readFileSync(join(root, 'docker', 'compose.yaml'), 'utf8'), images),
);
const copied = ['compose.yaml', 'LICENSE', 'SECURITY.md', 'docker/backup.sh', 'backups/.gitignore'];
for (const file of copied) {
  copyFileSync(join(root, file), join(stage, file));
}
writeFileSync(join(stage, 'VERSION'), `${version}\n`);

const archive = join(out, `${name}.tar.gz`);
const files = ['VERSION', ...copied, 'docker/compose.yaml'].toSorted();
// Our own ustar writer (ADR 0082): the same on every host, and with fixed times the same inputs
// give the same archive.
async function* entries() {
  for (const file of files) {
    yield { name: `${name}/${file}`, data: readFileSync(join(stage, file)), mtime: new Date(0) };
  }
}
await pipeline(Readable.from(tarStream(entries())), createGzip(), createWriteStream(archive));
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
process.stdout.write(`${archive}\n`);
