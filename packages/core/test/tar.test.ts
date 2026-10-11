import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { tarHeader, tarStream } from '../src/export/tar.ts';
import type { TarEntry } from '../src/export/tar.ts';
import { archiveFilename } from '../src/principals/export.ts';

/*
 * The ustar writer behind the person export (NF-P4, ADR 0082), read back with a reader written
 * here from the format, so the test does not trust the writer to check itself.
 */

async function archive(entries: TarEntry[]): Promise<Buffer> {
  async function* source() {
    yield* entries;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream(source())) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length).toString('ascii');
  const nul = raw.indexOf('\0');
  return nul === -1 ? raw : raw.slice(0, nul);
}

/** Every file in the archive, and where the end marker starts; checks each header's checksum. */
function parse(tar: Buffer): {
  files: { name: string; data: Buffer; mtime: number }[];
  end: number;
} {
  const files = [];
  let at = 0;
  while (!tar.subarray(at, at + 512).every((b) => b === 0)) {
    const header = tar.subarray(at, at + 512);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
    expect(Number.parseInt(field(header, 148, 8).trim(), 8)).toBe(sum);
    expect(field(header, 257, 6)).toBe('ustar');
    expect(field(header, 156, 1)).toBe('0');
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const size = Number.parseInt(field(header, 124, 12), 8);
    const mtime = Number.parseInt(field(header, 136, 12), 8);
    at += 512;
    files.push({
      name: prefix === '' ? name : `${prefix}/${name}`,
      data: tar.subarray(at, at + size),
      mtime,
    });
    at += Math.ceil(size / 512) * 512;
  }
  return { files, end: at };
}

/** The files, after checking the archive ends with exactly two zero blocks. */
function read(tar: Buffer) {
  const { files, end } = parse(tar);
  expect(tar.length).toBe(end + 1024);
  expect(tar.subarray(end).every((b) => b === 0)).toBe(true);
  return files;
}

describe('tar writer (NF-P4)', () => {
  it('NF-P4: writes files that read back byte for byte, padded to blocks, with the end marker', async () => {
    const binary = Buffer.from(Array.from({ length: 1300 }, (_, i) => i % 256));
    const tar = await archive([
      {
        name: 'lakka-export/manifest.json',
        data: Buffer.from('{"a":1}\n'),
        mtime: new Date(1_790_000_000_000),
      },
      { name: 'lakka-export/attachments/x/photo.png', data: binary },
      { name: 'lakka-export/empty.json', data: Buffer.alloc(0) },
      { name: 'lakka-export/exact.bin', data: Buffer.alloc(512, 7) },
    ]);
    expect(tar.length % 512).toBe(0);
    const files = read(gunzipSync(gzipSync(tar)));
    expect(files.map((f) => f.name)).toEqual([
      'lakka-export/manifest.json',
      'lakka-export/attachments/x/photo.png',
      'lakka-export/empty.json',
      'lakka-export/exact.bin',
    ]);
    expect(files[0]?.data.toString()).toBe('{"a":1}\n');
    expect(files[0]?.mtime).toBe(1_790_000_000);
    expect(files[1]?.data.equals(binary)).toBe(true);
    expect(files[2]?.data.length).toBe(0);
    expect(files[3]?.data.equals(Buffer.alloc(512, 7))).toBe(true);
  });

  it('NF-P4: a name past 100 characters goes in the prefix field', async () => {
    const name = `lakka-export/workspaces/${'w'.repeat(60)}/conversations/${'c'.repeat(36)}.json`;
    expect(name.length).toBeGreaterThan(100);
    const [file] = read(await archive([{ name, data: Buffer.from('x') }]));
    expect(file?.name).toBe(name);
  });

  it('refuses names that could escape the archive or do not fit', () => {
    for (const name of [
      '../etc/passwd',
      '/abs',
      'a/../b',
      'a//b',
      'with space',
      'café',
      'x'.repeat(101),
    ]) {
      expect(() => tarHeader({ name, size: 0 })).toThrow(/tar:/);
    }
  });

  it('keeps an attachment name recognisable but safe', () => {
    expect(archiveFilename('Q3 plan (final).pdf')).toBe('Q3_plan__final_.pdf');
    expect(archiveFilename('../../x')).toBe('.._.._x');
    expect(archiveFilename('..')).toBe('file');
    expect(archiveFilename(null)).toBe('file');
    expect(archiveFilename(`${'a'.repeat(100)}.png`)).toHaveLength(80);
  });
});
