import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.ts';
import { t, tNodes } from '../src/i18n/index.ts';

describe('UI strings (NF-A2)', () => {
  it('looks up strings and fills placeholders', () => {
    expect(t('signIn.provider', { name: 'Okta' })).toBe('Sign in with Okta');
    expect(t('nav.signedInAs', {})).toBe('Signed in as {name}');
  });

  it('NF-A2: fills placeholders with markup, keeping the sentence in one string', () => {
    const tool = createElement('code', null, 'github.create_pull_request');
    expect(tNodes('approval.title', { tool })).toEqual(['Allow ', tool, ' to run?']);
  });

  it('keeps committed copy free of non-ASCII characters and emoji', () => {
    for (const [key, value] of Object.entries(en)) {
      expect({ key, ascii: /^[\x20-\x7e]*$/.test(value) }).toEqual({ key, ascii: true });
    }
  });
});
