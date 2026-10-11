import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/*
 * The credential master key's versions (NF-S1, NF-S9, ADR 0115). Never the key: `key_id` is an
 * HMAC fingerprint of it, so a process given the wrong or no key for a version refuses to start
 * instead of writing values nobody can read. The active version is the highest one activated;
 * stored values name their version in their prefix ("v2:...").
 *
 * Instance-level, like instance_setup: no workspace owns a key.
 */
export const credentialKeys = pgTable(
  'credential_keys',
  {
    version: integer('version').primaryKey(),
    keyId: text('key_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when writes switched to this version; null for a key recorded but never used. */
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /** Set when no stored value used this version any more and its key file was removed. */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [check('credential_keys_version_check', sql`${t.version} >= 1`)],
);
