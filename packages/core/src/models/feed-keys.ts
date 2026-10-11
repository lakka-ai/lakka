/*
 * The public keys a signed price feed may be checked with (PR-6, ADR 0116). Baked into the
 * image: a feed signed by any other key is refused, wherever it was fetched from.
 *
 * The project owner holds the private halves offline: a primary key and a backup key, kept in a
 * password manager and nowhere else. Nobody else can sign a feed. Both public keys are listed
 * below, as `pnpm catalogue:keygen` printed them; a build whose list is empty cannot turn the
 * feed on. A compromised key is removed by a release without it, with an advisory (SECURITY.md,
 * docs/releasing.md).
 */

export interface FeedKey {
  /** The first 16 hex digits of the SHA-256 of the raw public key; the envelope names it. */
  keyId: string;
  /** The raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
}

export const PRODUCTION_FEED_KEYS: readonly FeedKey[] = [
  // The primary key: every feed is signed with it.
  { keyId: '616cb5edac72f3f2', publicKey: 'W0vnQx7XujR1z4VgMuUrOs2A78E-B_MTVx9XtamwPVs' },
  // The backup key: used only if the primary is lost or compromised.
  { keyId: '6a849a50e2d7ef0e', publicKey: 'H3xhWrFX-luBoFNb14du4LDo4I1m0T1NRDSLOqS1VcU' },
];
