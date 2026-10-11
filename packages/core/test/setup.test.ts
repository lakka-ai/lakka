import { describe, expect, it } from 'vitest';
import { setupCodeMatches } from '../src/setup/service.ts';

describe('setup code', () => {
  it('AD-1: only the configured code matches, ignoring surrounding whitespace from a paste', () => {
    const code = 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE';
    expect(setupCodeMatches(code, code)).toBe(true);
    expect(setupCodeMatches(code, `  ${code}\n`)).toBe(true);
    expect(setupCodeMatches(code, code.slice(0, -1))).toBe(false);
    expect(setupCodeMatches(code, `${code}x`)).toBe(false);
    expect(setupCodeMatches(code, '')).toBe(false);
  });

  it('AD-1: with no code configured, nothing matches', () => {
    expect(setupCodeMatches(undefined, '')).toBe(false);
    expect(setupCodeMatches(undefined, 'anything')).toBe(false);
  });
});
