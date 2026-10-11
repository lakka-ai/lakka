/* Signing in with an identity provider (ID-2, ADR 0032), from sign-in and from an invite. */

/** Starts signing in with a provider; the browser leaves for it, and comes back to `returnTo`. */
export async function startSso(providerId: string, returnTo: string): Promise<boolean> {
  const response = await fetch('/api/auth/sign-in/sso', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId, callbackURL: returnTo, errorCallbackURL: '/sign-in' }),
  });
  const body: unknown = await response.json().catch(() => null);
  const url =
    body !== null && typeof body === 'object' && 'url' in body ? String(body.url) : undefined;
  if (!response.ok || url === undefined) return false;
  window.location.assign(url);
  return true;
}
