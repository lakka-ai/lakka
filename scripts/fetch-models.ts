import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesFor, noticeFor, targetArch } from './models.ts';
import type { Manifest, ModelFile } from './models.ts';

/*
 * Downloads the classifier model files pinned in models/manifest.json and verifies each one by
 * size and sha256 (ADR 0022). Used by the image build and by `pnpm models:fetch` for
 * development. Nothing downloads at runtime (NF-D5, CLAUDE.md invariant 12). A file meant for
 * one architecture is fetched only for it: TARGETARCH in the image build, else this machine's
 * (ADR 0124). Each model's directory also gets its license text and a NOTICE naming the source.
 *
 * Usage: node scripts/fetch-models.ts [output-dir]   (default: models/)
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(root, 'models'));
const manifest = JSON.parse(
  readFileSync(join(root, 'models', 'manifest.json'), 'utf8'),
) as Manifest;
const arch = targetArch(process.env, process.arch);

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function verified(path: string, file: ModelFile): boolean {
  if (!existsSync(path)) return false;
  const data = readFileSync(path);
  return data.byteLength === file.size && sha256(data) === file.sha256;
}

for (const model of manifest.models) {
  const dir = join(outDir, model.name);
  mkdirSync(dir, { recursive: true });
  const files = filesFor(model, arch);
  for (const file of files) {
    const target = join(dir, file.path);
    if (verified(target, file)) {
      process.stdout.write(`ok       ${model.name}/${file.path} (${arch})\n`);
      continue;
    }
    const response = await fetch(file.url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength !== file.size || sha256(data) !== file.sha256) {
      throw new Error(`${model.name}/${file.path}: size or sha256 does not match the manifest`);
    }
    writeFileSync(`${target}.tmp`, data);
    renameSync(`${target}.tmp`, target);
    process.stdout.write(`fetched  ${model.name}/${file.path} (${arch})\n`);
  }
  copyFileSync(join(root, 'models', 'licenses', `${model.license}.txt`), join(dir, 'LICENSE'));
  writeFileSync(join(dir, 'NOTICE'), noticeFor(model, files, arch));
}
