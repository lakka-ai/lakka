/*
 * A minimal ustar writer for the person export (NF-P4, ADR 0082). Only regular files, with names
 * we choose ourselves, so it needs none of tar's harder parts: no links, no long names beyond
 * the ustar prefix field, no extended headers. Entries are produced one at a time, so an export
 * holds one file in memory, never the archive. Node's zlib compresses the stream.
 */

export interface TarEntry {
  /** A relative path of printable ASCII, directories separated by `/`. */
  name: string;
  data: Uint8Array;
  mtime?: Date;
}

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
// Segments of printable ASCII other than `/`, joined by single slashes.
const SAFE_NAME = /^[\x21-\x2e\x30-\x7e]+(\/[\x21-\x2e\x30-\x7e]+)*$/;

function octal(value: number, width: number): string {
  // width - 1 digits and a terminating NUL, as ustar expects.
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** Splits a path into ustar's prefix and name fields, or throws if it cannot fit. */
function splitName(path: string): { prefix: string; name: string } {
  if (!SAFE_NAME.test(path) || path.split('/').some((p) => p === '.' || p === '..')) {
    throw new Error('tar: unsafe entry name');
  }
  if (path.length <= NAME_MAX) return { prefix: '', name: path };
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (prefix.length <= PREFIX_MAX && name.length <= NAME_MAX) return { prefix, name };
  }
  throw new Error('tar: entry name too long');
}

export function tarHeader(entry: { name: string; size: number; mtime?: Date }): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const { prefix, name } = splitName(entry.name);
  const mtime = Math.floor((entry.mtime ?? new Date(0)).getTime() / 1000);
  header.write(name, 0, 'ascii');
  header.write(octal(0o644, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii');
  header.write(octal(0, 8), 116, 'ascii');
  header.write(octal(entry.size, 12), 124, 'ascii');
  header.write(octal(mtime, 12), 136, 'ascii');
  // The checksum is summed with its own field as spaces.
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.write(prefix, 345, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

/** The archive, as chunks: each entry's header, its bytes padded to a block, then the end. */
export async function* tarStream(entries: AsyncIterable<TarEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    yield tarHeader({
      name: entry.name,
      size: entry.data.byteLength,
      ...(entry.mtime === undefined ? {} : { mtime: entry.mtime }),
    });
    yield Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const padding = (BLOCK - (entry.data.byteLength % BLOCK)) % BLOCK;
    if (padding > 0) yield Buffer.alloc(padding, 0);
  }
  yield Buffer.alloc(BLOCK * 2, 0);
}
