import { z } from 'zod';
import { catalogueFile } from './models.ts';

/*
 * The signed model price feed (PR-6, ADR 0116): an opt-in way to get new catalogue prices
 * between releases. Off by default; an instance admin turns it on, and an operator can lock it
 * off with LAKKA_CATALOGUE_FEED_URL=off.
 *
 * The file is an envelope around the signed bytes. The signature is Ed25519 over the domain
 * line "lakka-catalogue-feed-v1\n" followed by the payload's bytes exactly as decoded, so
 * nothing is re-serialized before checking it. A breaking format change gets a new path (-v2).
 */

export const CATALOGUE_FEED_FORMAT = 1;

/** The bundled file's shape, with when it was signed. */
export const catalogueFeedPayload = catalogueFile.extend({ issuedAt: z.iso.datetime() });
export type CatalogueFeedPayload = z.infer<typeof catalogueFeedPayload>;

export const catalogueFeedEnvelope = z
  .object({
    format: z.literal(CATALOGUE_FEED_FORMAT),
    /** Which baked-in public key signed it: the first 16 hex digits of its SHA-256. */
    keyId: z.string().regex(/^[0-9a-f]{16}$/),
    payload: z.base64().min(1),
    signature: z.base64().min(1).max(128),
  })
  .strict();
export type CatalogueFeedEnvelope = z.infer<typeof catalogueFeedEnvelope>;

/** Why a check did not apply a feed. Any of them refuses the whole feed. */
export const CATALOGUE_FEED_ERROR_CODES = [
  'unreachable',
  'timeout',
  'http_status',
  'too_large',
  'invalid_feed',
  'unknown_key',
  'bad_signature',
  'not_newer',
  'too_many_models',
  'untrusted_provider',
  'zero_price',
  'tier_lowers_price',
  'price_drop',
] as const;
export type CatalogueFeedErrorCode = (typeof CATALOGUE_FEED_ERROR_CODES)[number];

export const CATALOGUE_FEED_RESULTS = ['applied', 'unchanged', 'failed'] as const;
export type CatalogueFeedResult = (typeof CATALOGUE_FEED_RESULTS)[number];

export const catalogueFeedBody = z.object({ enabled: z.boolean() }).strict();
export type CatalogueFeedBody = z.infer<typeof catalogueFeedBody>;

/** Price updates as instance admins see them on the Models page. */
export interface CatalogueFeedView {
  enabled: boolean;
  /**
   * Why it cannot be turned on: an operator locked it off, or this build has no key to check a
   * feed with. Null when an admin may turn it on.
   */
  unavailable: 'locked' | 'no_key' | null;
  /** The host the server contacts, which sees the server's address; null when locked. */
  host: string | null;
  /** Who last turned it on or off, and when. */
  changedBy: string | null;
  changedAt: string | null;
  lastCheckedAt: string | null;
  lastResult: CatalogueFeedResult | null;
  lastErrorCode: CatalogueFeedErrorCode | null;
  /** The newest feed applied, which stays recorded while it is off. */
  appliedSerial: number | null;
  appliedAt: string | null;
  /** This release's catalogue. */
  bundledSerial: number;
  /** Whose prices apply now: the release's, or a newer feed's while it is on. */
  activeSerial: number;
  /** An admin asked for a check that the worker has not run yet. */
  checkRequested: boolean;
}
