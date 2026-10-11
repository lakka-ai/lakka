import { isPrivateHostLiteral } from './public-address.ts';

/*
 * Where MCP traffic may go (NF-S4, ADR 0117), decided in one place: Lakka's own requests to an
 * MCP server and its authorization server (guarded-fetch.ts), and anything else that has to make
 * the same call, such as a proxy for a tool's own requests. Pure: no DNS, no I/O.
 *
 * - An origin is allowed only when it is listed: by an instance admin, or by the operator in
 *   LAKKA_MCP_PRIVATE_ORIGINS. Exact origins, no wildcards.
 * - Listing an origin does not open the private network (ADR 0067): an address on it is reached
 *   only by an instance admin's server (`allowPrivate`) or at an origin the operator listed as
 *   private. Everything else is public-only, which the caller enforces when it resolves the
 *   name, since a name can point anywhere at any time.
 */

/** More origins than any instance lists; the list stops growing here, so a rule stays small. */
export const MAX_ALLOWED_ORIGINS = 1000;

export interface EgressRule {
  /** Origins that may be reached at all, as normaliseOrigin writes them. */
  allowedOrigins: readonly string[];
  /** Origins on a private network the operator listed (LAKKA_MCP_PRIVATE_ORIGINS). */
  privateOrigins: readonly string[];
  /** The traffic is for an instance admin's server, which may be on a private network. */
  allowPrivate: boolean;
}

export type EgressDecision =
  | {
      allowed: true;
      origin: string;
      /** Resolve the name to public addresses only, and refuse it otherwise. */
      publicOnly: boolean;
    }
  /** Not http or https, such as file: or data:, so there is no origin to list. */
  | { allowed: false; origin: null; reason: 'not_http' }
  | { allowed: false; origin: string; reason: 'not_listed' | 'private_address' };

/**
 * The origin of an http or https URL, as it is listed and compared: lowercase scheme and host,
 * an international name in its ASCII form, no default port. Null for anything else.
 */
export function normaliseOrigin(input: string | URL): string | null {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin;
}

export function decideEgress(input: string | URL, rule: EgressRule): EgressDecision {
  const origin = normaliseOrigin(input);
  if (origin === null) return { allowed: false, origin: null, reason: 'not_http' };
  const listedPrivate = rule.privateOrigins.includes(origin);
  if (!listedPrivate && !rule.allowedOrigins.includes(origin)) {
    return { allowed: false, origin, reason: 'not_listed' };
  }
  const publicOnly = !rule.allowPrivate && !listedPrivate;
  // A literal address is never looked up, so the public-only check happens here for it.
  if (publicOnly && isPrivateHostLiteral(new URL(origin).hostname)) {
    return { allowed: false, origin, reason: 'private_address' };
  }
  return { allowed: true, origin, publicOnly };
}
