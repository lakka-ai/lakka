import { describe, expect, it } from 'vitest';
import { estimateInputTokens, estimateTextTokens } from '../src/gateway/estimate.ts';

const image = (bytes: number) => ({
  messages: [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: '' },
        {
          type: 'file' as const,
          mediaType: 'image/png' as const,
          data: 'A'.repeat(Math.ceil((bytes * 4) / 3)),
        },
      ],
    },
  ],
});
const pdf = (bytes: number) => ({
  messages: [
    {
      role: 'user' as const,
      content: [
        {
          type: 'file' as const,
          mediaType: 'application/pdf' as const,
          data: 'A'.repeat((bytes / 3) * 4),
        },
      ],
    },
  ],
});

describe('token estimates (ADR 0040)', () => {
  it('the typical reading is close for English, and the upper reading is always at least double', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const typical = estimateTextTokens(text, 'typical');
    const upper = estimateTextTokens(text, 'upper');
    expect(typical).toBe(Math.ceil(Buffer.byteLength(text) / 4));
    expect(upper).toBe(2 * typical);
  });

  it('counts bytes, so text in scripts with several bytes per character is not undercounted', () => {
    // Four Japanese characters (12 bytes) are four or more tokens; the upper reading gives six.
    expect(estimateTextTokens('\u3053\u3093\u306b\u3061', 'upper')).toBe(6);
  });

  it('adds an overhead per message', () => {
    expect(
      estimateInputTokens(
        {
          messages: [
            { role: 'user', content: '' },
            { role: 'user', content: '' },
          ],
        },
        'typical',
      ),
    ).toBe(16);
  });

  it('CH-5, BG-2: an image costs a flat figure, above what any common model charges at the upper reading', () => {
    // The same figure for a small and a large image; the overhead of 8 is the message's.
    expect(estimateInputTokens(image(1_000), 'upper')).toBe(8 + 5_000);
    expect(estimateInputTokens(image(5_000_000), 'upper')).toBe(8 + 5_000);
    expect(estimateInputTokens(image(1_000), 'typical')).toBe(8 + 1_600);
  });

  it('CH-5, BG-2: a text file is counted as the text the model is given, wrapping and all', () => {
    const text = 'x'.repeat(4_000);
    const request = {
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'file' as const,
              mediaType: 'text/plain' as const,
              data: Buffer.from(text).toString('base64'),
              filename: 'a.txt',
            },
          ],
        },
      ],
    };
    // 4,000 bytes of text plus the 36 bytes of <document name="a.txt">, two line breaks and </document>.
    expect(estimateInputTokens(request, 'upper')).toBe(8 + Math.ceil(4_036 / 2));
    expect(estimateInputTokens(request, 'typical')).toBe(8 + Math.ceil(4_036 / 4));
  });

  it('CH-5, BG-2: a PDF is estimated from its size, never below 5,000 tokens at the upper reading', () => {
    expect(estimateInputTokens(pdf(30_000), 'upper')).toBe(8 + 5_000);
    expect(estimateInputTokens(pdf(3_000_000), 'upper')).toBe(8 + 120_000);
    expect(estimateInputTokens(pdf(3_000_000), 'typical')).toBe(8 + 30_000);
  });
});
