import { describe, expect, it } from 'vitest';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type { GatewayStreamEvent } from '@lakka/contracts';
import { commitFirstChunk } from '../src/gateway/commit.ts';
import { ProviderStreamError, streamModelCall, toPrompt } from '../src/gateway/model-call.ts';

const usage = (
  overrides: Partial<LanguageModelV4Usage['inputTokens']> = {},
): LanguageModelV4Usage => ({
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
    ...overrides,
  },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
});

const finishPart = (u = usage()): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage: u,
  finishReason: { unified: 'stop', raw: 'end_turn' },
});

/** A model whose doStream replays `parts`, or fails before the stream opens. */
function mockModel(plan: { parts?: LanguageModelV4StreamPart[]; reject?: Error }) {
  const log = { calls: [] as LanguageModelV4CallOptions[], cancelled: false };
  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-1',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('not used')),
    doStream: (options) => {
      log.calls.push(options);
      if (plan.reject !== undefined) return Promise.reject(plan.reject);
      const parts = [...(plan.parts ?? [])];
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          pull(controller) {
            const next = parts.shift();
            if (next === undefined) controller.close();
            else controller.enqueue(next);
          },
          cancel() {
            log.cancelled = true;
          },
        }),
      });
    },
  };
  return { model, log };
}

async function collect(stream: AsyncIterable<GatewayStreamEvent>) {
  const out: GatewayStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const request = { messages: [{ role: 'user' as const, content: 'hi' }] };
const signal = () => new AbortController().signal;

describe('streamModelCall', () => {
  it('turns provider parts into text, reasoning and finish events, skipping metadata', async () => {
    const { model } = mockModel({
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'r1' },
        { type: 'reasoning-delta', id: 'a', delta: 'thinking' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '' },
        { type: 'text-delta', id: 't', delta: 'Hel' },
        { type: 'text-delta', id: 't', delta: 'lo' },
        { type: 'text-end', id: 't' },
        finishPart(usage({ total: 12, noCache: undefined })),
      ],
    });
    expect(await collect(streamModelCall(model, request, signal()))).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      {
        type: 'finish',
        finishReason: 'stop',
        // A split the provider did not report stays null; it is never guessed as zero.
        usage: {
          inputTokens: 12,
          uncachedInputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          outputTokens: 3,
          reasoningTokens: null,
        },
      },
    ]);
  });

  it('passes the prompt, limits and abort signal to the provider', async () => {
    const { model, log } = mockModel({ parts: [finishPart()] });
    const s = signal();
    await collect(
      streamModelCall(
        model,
        { ...request, maxOutputTokens: 50, temperature: 0.2, stopSequences: ['END'] },
        s,
      ),
    );
    expect(log.calls[0]).toMatchObject({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 50,
      temperature: 0.2,
      stopSequences: ['END'],
      abortSignal: s,
    });
  });

  it('keeps system messages as plain strings, the shape providers expect', () => {
    expect(
      toPrompt({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'assistant', content: 'Earlier answer' },
        ],
      }),
    ).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
    ]);
  });

  it('H4: tools are offered, calls and results carry over, and tool-call parts become events', async () => {
    const { model, log } = mockModel({
      parts: [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'srv__echo', input: '{"text":"hi"}' },
        {
          type: 'tool-call',
          toolCallId: 'p1',
          toolName: 'web_search',
          input: '{}',
          providerExecuted: true,
        },
        {
          type: 'finish',
          usage: usage(),
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        },
      ],
    });
    const events = await collect(
      streamModelCall(
        model,
        {
          messages: [
            { role: 'user', content: 'hi' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'c0', name: 'srv__echo', arguments: '{"text":"a"}' }],
            },
            { role: 'tool', content: 'a', toolCallId: 'c0', toolName: 'srv__echo' },
            {
              role: 'tool',
              content: 'failed',
              toolCallId: 'c9',
              toolName: 'srv__echo',
              isError: true,
            },
          ],
          tools: [{ name: 'srv__echo', inputSchema: { type: 'object' } }],
        },
        signal(),
      ),
    );
    expect(log.calls[0]).toMatchObject({
      tools: [{ type: 'function', name: 'srv__echo', inputSchema: { type: 'object' } }],
      toolChoice: { type: 'auto' },
      prompt: [
        { role: 'user' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c0', toolName: 'srv__echo', input: { text: 'a' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c0',
              toolName: 'srv__echo',
              output: { type: 'text', value: 'a' },
            },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', output: { type: 'error-text', value: 'failed' } }],
        },
      ],
    });
    // A call the provider ran itself is not ours to answer.
    expect(events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', callId: 'c1', name: 'srv__echo', arguments: '{"text":"hi"}' },
    ]);
  });

  it('CH-5: files go to the provider as inline data, never as a URL, and only in user messages', () => {
    expect(
      toPrompt({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read these' },
              { type: 'file', mediaType: 'image/png', data: 'aGk=' },
              { type: 'file', mediaType: 'application/pdf', data: 'aGk=', filename: 'a.pdf' },
            ],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        ],
      }),
    ).toEqual([
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read these' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } },
          {
            type: 'file',
            mediaType: 'application/pdf',
            data: { type: 'data', data: 'aGk=' },
            filename: 'a.pdf',
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]);
  });

  it('CH-5: a text file reaches every model as its text, delimited and named (ADR 0106)', () => {
    const notes = Buffer.from('Line one\nLine "two"', 'utf8').toString('base64');
    expect(
      toPrompt({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Summarize' },
              { type: 'file', mediaType: 'text/plain', data: notes, filename: 'my "notes".txt' },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize' },
          {
            type: 'text',
            text: '<document name="my  notes .txt">\nLine one\nLine "two"\n</document>',
          },
        ],
      },
    ]);
  });

  it('raises an error part as ProviderStreamError, keeping the provider error as its cause', async () => {
    const cause = new Error('overloaded');
    const { model } = mockModel({
      parts: [
        { type: 'text-delta', id: 't', delta: 'a' },
        { type: 'error', error: cause },
      ],
    });
    const error: unknown = await collect(streamModelCall(model, request, signal())).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProviderStreamError);
    expect((error as Error).cause).toBe(cause);
  });

  it('cancels the provider stream when the caller stops reading early', async () => {
    const { model, log } = mockModel({
      parts: [
        { type: 'text-delta', id: 't', delta: 'a' },
        { type: 'text-delta', id: 't', delta: 'b' },
        finishPart(),
      ],
    });
    for await (const e of streamModelCall(model, request, signal())) {
      expect(e).toEqual({ type: 'text', text: 'a' });
      break;
    }
    expect(log.cancelled).toBe(true);
  });

  it('invariant 6: a provider that fails before its stream opens is retried inside the commitment window', async () => {
    const failing = mockModel({ reject: Object.assign(new Error('503'), { statusCode: 503 }) });
    const working = mockModel({
      parts: [{ type: 'text-delta', id: 't', delta: 'ok' }, finishPart()],
    });
    const models = [failing.model, working.model];
    const committed = await commitFirstChunk(
      (s, attempt) => streamModelCall(models[attempt - 1] ?? working.model, request, s),
      { maxAttempts: 2, firstChunkTimeoutMs: 1000, backoffMs: () => 0 },
    );
    expect(committed.attempts).toBe(2);
    expect((await collect(committed)).map((e) => e.type)).toEqual(['text', 'finish']);
  });
});
