import { describe, expect, it } from 'vitest';
import { slugFor } from '../src/lib/slug.ts';
import { hostOf } from '../src/lib/about.ts';

describe('first-run setup and sign-in (AD-1, ID-2, ADR 0098)', () => {
  it("AD-1: the first workspace's name for links is made from its name", () => {
    expect(slugFor('Product')).toBe('product');
    expect(slugFor('  Nordlys -- Design team! ')).toBe('nordlys-design-team');
    expect(slugFor('Åre')).toBe('are');
    expect(slugFor('!!!')).toBe('workspace');
    expect(slugFor('x'.repeat(80))).toHaveLength(63);
  });

  it('ID-2: sign-in names the host the page came from, and nothing that is not a host', () => {
    expect(hostOf(undefined, 'ai.nordlys.se')).toBe('ai.nordlys.se');
    expect(hostOf('ai.nordlys.se, proxy.internal', 'web:3000')).toBe('ai.nordlys.se');
    expect(hostOf(undefined, '127.0.0.1:8080')).toBe('127.0.0.1:8080');
    expect(hostOf(undefined, '<script>')).toBe('');
    expect(hostOf(undefined, undefined)).toBe('');
  });
});
