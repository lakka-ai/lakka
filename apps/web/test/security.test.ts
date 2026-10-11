import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, DOCUMENT_HEADERS, newNonce } from '../src/lib/security.ts';
import { PROJECT_REPOSITORY, sourceUrlFrom } from '../src/lib/source-url.ts';

/* The page policy (ADR 0075 H6) and the AGPL source link (AD-6), from ADR 0085. */

describe('the content security policy (H6)', () => {
  it('H6: scripts run only with the nonce, never inline or from eval, and nothing frames the app', () => {
    const policy = contentSecurityPolicy('abc123==');
    const directives = new Map(
      policy.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)] as const),
    );
    expect(directives.get('script-src')).toEqual(["'nonce-abc123=='", "'strict-dynamic'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);
    expect(policy).not.toMatch(/unsafe-eval/);
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'");
    expect(DOCUMENT_HEADERS['x-content-type-options']).toBe('nosniff');
  });

  it('H6: every document gets a new, unguessable nonce', () => {
    const nonces = new Set(Array.from({ length: 100 }, newNonce));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe('the AGPL source link (AD-6)', () => {
  it('AD-6: an operator running changed code points it at their source', () => {
    expect(sourceUrlFrom({ LAKKA_SOURCE_URL: 'https://git.example.com/our-fork' })).toBe(
      'https://git.example.com/our-fork',
    );
  });

  it('AD-6: otherwise it is the project at the revision the image was built from', () => {
    expect(sourceUrlFrom({ LAKKA_REVISION: 'f2881e74a9855ab071ced74c496999b4ece27d08' })).toBe(
      `${PROJECT_REPOSITORY}/tree/f2881e74a9855ab071ced74c496999b4ece27d08`,
    );
    expect(sourceUrlFrom({})).toBe(PROJECT_REPOSITORY);
    expect(sourceUrlFrom({ LAKKA_REVISION: 'unknown' })).toBe(PROJECT_REPOSITORY);
  });

  it('never links to something that is not a web address', () => {
    expect(sourceUrlFrom({ LAKKA_SOURCE_URL: 'javascript:alert(1)' })).toBe(PROJECT_REPOSITORY);
    expect(sourceUrlFrom({ LAKKA_SOURCE_URL: 'not a url' })).toBe(PROJECT_REPOSITORY);
  });
});
