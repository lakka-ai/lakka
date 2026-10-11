import { describe, expect, it } from 'vitest';
import { originAllowed } from '../src/origin-check.ts';

const TRUSTED = ['http://localhost:8080'];
const check = (method: string, headers: Record<string, string>) =>
  originAllowed({ method, headers }, TRUSTED);

describe('originAllowed (ADR 0006)', () => {
  it('always allows safe methods', () => {
    expect(check('GET', { cookie: 's=1', origin: 'https://evil.example' })).toBe(true);
  });

  it('allows a trusted origin and refuses any other, with or without a cookie', () => {
    expect(check('POST', { cookie: 's=1', origin: 'http://localhost:8080' })).toBe(true);
    expect(check('POST', { cookie: 's=1', origin: 'https://evil.example' })).toBe(false);
    expect(check('POST', { origin: 'https://evil.example' })).toBe(false);
  });

  it('with no Origin, requires Sec-Fetch-Site same-origin when a cookie is present', () => {
    expect(check('POST', { cookie: 's=1' })).toBe(false);
    expect(check('POST', { cookie: 's=1', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(check('POST', { cookie: 's=1', 'sec-fetch-site': 'same-origin' })).toBe(true);
  });

  it('allows non-browser clients that send neither Origin nor cookie', () => {
    expect(check('POST', {})).toBe(true);
  });

  it('exempts requests authenticated by an Authorization header', () => {
    expect(check('DELETE', { authorization: 'Bearer x', origin: 'https://evil.example' })).toBe(
      true,
    );
  });
});
