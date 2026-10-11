import { describe, expect, it } from 'vitest';
import {
  capturedPrompt,
  capturedResponse,
  MAX_CAPTURED_CHARS,
} from '../src/observability/capture.ts';

/* How captured content is shaped (OB-4, ADR 0077): what was said, cut when huge, files described. */

describe('captured content (OB-4)', () => {
  it('OB-4: keeps messages, tool calls and results, and describes files without their bytes', () => {
    const data = Buffer.from('fake image bytes').toString('base64');
    expect(
      capturedPrompt({
        messages: [
          { role: 'system', content: 'Be brief.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look' },
              { type: 'file', mediaType: 'image/png', data, filename: 'a.png' },
            ],
          },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'srv__echo', arguments: '{"text":"hi"}' }],
          },
          { role: 'tool', content: 'hi', toolCallId: 'c1', toolName: 'srv__echo' },
        ],
        tools: [{ name: 'srv__echo', inputSchema: { type: 'object' } }],
      }),
    ).toEqual({
      messages: [
        { role: 'system', content: 'Be brief.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            { type: 'file', mediaType: 'image/png', filename: 'a.png', bytes: 16 },
          ],
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'srv__echo', arguments: '{"text":"hi"}' }],
        },
        { role: 'tool', content: 'hi', toolCallId: 'c1', toolName: 'srv__echo' },
      ],
      tools: ['srv__echo'],
    });
  });

  it('cuts a huge text, saying how much was left out', () => {
    const reply = capturedResponse(
      { text: 'x'.repeat(MAX_CAPTURED_CHARS + 10), reasoning: '', toolCalls: [] },
      'length',
    ) as { text: string; finishReason: string };
    expect(reply.text.length).toBeLessThan(MAX_CAPTURED_CHARS + 100);
    expect(reply.text).toMatch(/\[cut: 10 more characters\]$/);
    expect(reply.finishReason).toBe('length');
  });
});
