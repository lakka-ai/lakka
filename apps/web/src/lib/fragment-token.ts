/*
 * One-time links carry their token in the fragment, which browsers never send to a server, so it
 * cannot land in a proxy or server log (ADR 0035, ADR 0098). The page reads it, removes it from
 * the address bar, and keeps it in this tab's session storage so it survives a detour, such as
 * through sign-in.
 */

export function readFragmentToken(storageKey: string, pattern: RegExp): string | null {
  const fromLink = window.location.hash.slice(1);
  try {
    if (pattern.test(fromLink)) {
      sessionStorage.setItem(storageKey, fromLink);
      window.history.replaceState(null, '', window.location.pathname);
      return fromLink;
    }
    const stored = sessionStorage.getItem(storageKey);
    return stored !== null && pattern.test(stored) ? stored : null;
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the link still works.
    return pattern.test(fromLink) ? fromLink : null;
  }
}

export function forgetFragmentToken(storageKey: string): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing stored, nothing to forget.
  }
}
