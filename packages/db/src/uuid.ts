import { getRandomValues } from 'node:crypto';

/*
 * UUIDv7 (RFC 9562): a 48-bit Unix millisecond timestamp, then random bits. Ids sort by creation
 * time, which keeps btree inserts local. Generated in the app because Postgres 16, our supported
 * minimum, has no uuidv7() (ADR 0010, ADR 0027).
 */
export function uuidv7(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new RangeError('timestamp must be a non-negative 48-bit integer of milliseconds');
  }
  const bytes = getRandomValues(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 9562 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The creation time encoded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}
