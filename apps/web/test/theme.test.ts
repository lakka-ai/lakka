import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('theme', () => {
  it('NF-A1: the bundled theme is the approved one, whose contrast was measured', () => {
    expect(read('../src/styles/lakka-theme.css')).toBe(
      read('../../../docs/design/theme/lakka-theme.css'),
    );
  });

  /*
   * Sizes and colors come from the scales in tokens.md, through the theme and app.css (ADR 0108).
   * A pixel font size or a hex color in a component bypasses them, as about 200 did before.
   * icons.tsx is the exception: its SVG mask is black and white by definition, not by theme.
   */
  it('NF-A1: components use the type scale and the theme, not pixel sizes or hex colors', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.tsx'),
    );
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(src, file), 'utf8');
      for (const match of text.matchAll(/text-\[[0-9.]+px\]/g)) found.push(`${file}: ${match[0]}`);
      if (!file.endsWith('icons.tsx')) {
        for (const match of text.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/g)) {
          found.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
