/*
 * The browser-side security policy (ADR 0075 H6, ADR 0085). Scripts run only with this
 * response's nonce, and whatever those load ('strict-dynamic'); nothing inline without it, no
 * eval, no plugins, no framing, no <base> tricks, and forms and connections stay on this origin.
 * Styles allow inline: React renders style attributes, and a style cannot run code.
 */

/** 128 random bits, base64: a fresh one for every document. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    // Attachment previews are shown from memory before they are sent.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Sent with every page, alongside the policy. */
export const DOCUMENT_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
