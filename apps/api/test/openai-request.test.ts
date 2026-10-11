import { describe, expect, it } from 'vitest';
import { InvalidRequestError } from '@lakka/contracts';
import { translateChatRequest } from '../src/openai/request.ts';
import type { FileLookup, StoredFile } from '../src/openai/request.ts';

/* The OpenAI chat-completions request, translated to the gateway's (API-1, API-6, ADR 0058). */

const PNG = Buffer.from('fake png bytes').toString('base64');
const PDF = Buffer.from('%PDF-1.7 fake').toString('base64');

const withPart = (part: unknown) => ({
  model: 'auto',
  messages: [{ role: 'user', content: [part] }],
});

const refused = async (body: unknown, lookUpFiles: FileLookup = null) => {
  try {
    await translateChatRequest(body, lookUpFiles);
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      return { message: error.message, param: (error as { param?: string }).param };
    }
    throw error;
  }
  throw new Error('expected the request to be refused');
};

describe('translating chat-completions requests (API-1)', () => {
  it('API-1: text messages, output limits and sampling carry over; developer counts as system', async () => {
    expect(
      await translateChatRequest({
        model: 'auto',
        messages: [
          { role: 'developer', content: 'Be brief.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi.' },
          { role: 'user', content: [{ type: 'text', text: 'Again' }] },
        ],
        max_completion_tokens: 100,
        max_tokens: 999,
        temperature: 0.2,
        top_p: 0.9,
        stop: 'END',
        stream: true,
        stream_options: { include_usage: true },
      }),
    ).toEqual({
      model: 'auto',
      stream: true,
      includeUsage: true,
      request: {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi.' },
          { role: 'user', content: [{ type: 'text', text: 'Again' }] },
        ],
        maxOutputTokens: 100,
        temperature: 0.2,
        topP: 0.9,
        stopSequences: ['END'],
      },
    });
  });

  it('API-6: optional fields that clients send and we have no use for are accepted and ignored', async () => {
    const translated = await translateChatRequest({
      model: 'openai:gpt-5-mini',
      messages: [{ role: 'user', content: 'Hi', name: 'ada' }],
      user: 'someone',
      seed: 7,
      frequency_penalty: 0,
      presence_penalty: 0,
      logit_bias: {},
      metadata: { tag: 'x' },
      store: false,
      n: 1,
      tools: [],
      response_format: { type: 'text' },
      stream_options: null,
    });
    expect(translated).toMatchObject({
      model: 'openai:gpt-5-mini',
      stream: false,
      includeUsage: false,
    });
    expect(translated.request).toEqual({ messages: [{ role: 'user', content: 'Hi' }] });
  });

  it('CH-5: images and PDFs sent inline become file parts', async () => {
    const { request } = await translateChatRequest({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${PNG}`, detail: 'high' },
            },
            {
              type: 'file',
              file: { file_data: `data:application/pdf;base64,${PDF}`, filename: 'a.pdf' },
            },
          ],
        },
      ],
    });
    expect(request.messages[0]?.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'file', mediaType: 'image/png', data: PNG },
      { type: 'file', mediaType: 'application/pdf', data: PDF, filename: 'a.pdf' },
    ]);
  });

  it('H4: function tools, the calls a reply made, and their results carry over', async () => {
    const { request } = await translateChatRequest({
      model: 'auto',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'The weather in a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
            strict: true,
          },
        },
        { type: 'function', function: { name: 'now' } },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      messages: [
        { role: 'user', content: 'Weather in Oslo?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'Rain' }] },
      ],
    });
    expect(request.tools).toEqual([
      {
        name: 'get_weather',
        description: 'The weather in a city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      },
      { name: 'now', inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(request.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Oslo"}' }],
      },
      { role: 'tool', content: 'Rain', toolCallId: 'call_1', toolName: 'get_weather' },
    ]);
    // tool_choice none means the model is offered no tools.
    const none = await translateChatRequest({
      model: 'auto',
      tools: [{ type: 'function', function: { name: 'now' } }],
      tool_choice: 'none',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(none.request.tools).toBeUndefined();
  });

  it('H4: what tools cannot honour is refused with a clear reason', async () => {
    const user = [{ role: 'user', content: 'x' }];
    expect(
      await refused({ model: 'auto', messages: user, functions: [{ name: 'f' }] }),
    ).toMatchObject({ param: 'functions' });
    expect(
      await refused({ model: 'auto', messages: user, tools: [{ type: 'web_search' }] }),
    ).toMatchObject({ param: 'tools[0]' });
    expect(
      await refused({
        model: 'auto',
        messages: user,
        tools: [{ type: 'function', function: { name: 'now' } }],
        tool_choice: 'required',
      }),
    ).toMatchObject({ param: 'tool_choice' });
    expect(
      await refused({
        model: 'auto',
        messages: user,
        tools: [{ type: 'function', function: { name: 'has spaces' } }],
      }),
    ).toMatchObject({ param: expect.stringMatching(/^tools/) });
    // A result must answer a call made earlier in the request.
    expect(
      await refused({
        model: 'auto',
        messages: [{ role: 'tool', tool_call_id: 'x', content: 'y' }],
      }),
    ).toMatchObject({ param: 'messages[0].tool_call_id' });
    expect(
      await refused({
        model: 'auto',
        messages: [{ role: 'assistant', content: null, tool_calls: [{}] }],
      }),
    ).toMatchObject({ param: 'messages[0].tool_calls[0]' });
    expect(
      await refused({
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: 'x',
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
        ],
      }),
    ).toMatchObject({ param: 'messages[0].tool_calls' });
    expect(
      await refused({ model: 'auto', messages: [{ role: 'function', content: 'x' }] }),
    ).toMatchObject({ param: 'messages[0].role' });
  });

  it('refuses what cannot be honoured: several choices, structured output, and files by URL or id', async () => {
    const base = { model: 'auto', messages: [{ role: 'user', content: 'x' }] };
    expect(await refused({ ...base, n: 2 })).toMatchObject({ param: 'n' });
    expect(await refused({ ...base, response_format: { type: 'json_schema' } })).toMatchObject({
      param: 'response_format',
    });
    expect(
      await refused(
        withPart({ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }),
      ),
    ).toMatchObject({
      param: 'messages[0].content[0].image_url.url',
      message: expect.stringMatching(/fetches nothing/),
    });
    expect(await refused(withPart({ type: 'file', file: { file_id: 'file-123' } }))).toMatchObject({
      param: 'messages[0].content[0].file',
    });
    expect(
      await refused(
        withPart({ type: 'image_url', image_url: { url: `data:image/svg+xml;base64,${PNG}` } }),
      ),
    ).toMatchObject({ message: expect.stringMatching(/Unsupported image type/) });
    expect(await refused(withPart({ type: 'input_audio', input_audio: {} }))).toMatchObject({
      param: 'messages[0].content[0]',
    });
  });

  it('CH-5: a plain text file is a file part, its data URL parameters ignored (ADR 0106)', async () => {
    const text = Buffer.from('Grüße, notes', 'utf8').toString('base64');
    const { request } = await translateChatRequest(
      withPart({
        type: 'file',
        file: { file_data: `data:text/plain;charset=utf-8;base64,${text}`, filename: 'n.txt' },
      }),
    );
    expect(request.messages[0]?.content).toEqual([
      { type: 'file', mediaType: 'text/plain', data: text, filename: 'n.txt' },
    ]);
  });

  it('CH-5: a text file that is not UTF-8 is refused, naming the part', async () => {
    const latin1 = Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]).toString('base64');
    const res = await refused(
      withPart({ type: 'file', file: { file_data: `data:text/plain;base64,${latin1}` } }),
    );
    expect(res.message).toContain('UTF-8');
  });

  it('CH-5: a file part may carry an image, keeping its name (ADR 0062)', async () => {
    const { request } = await translateChatRequest(
      withPart({
        type: 'file',
        file: { file_data: `data:image/png;base64,${PNG}`, filename: 'cat.png' },
      }),
    );
    expect(request.messages[0]?.content).toEqual([
      { type: 'file', mediaType: 'image/png', data: PNG, filename: 'cat.png' },
    ]);
    expect(
      await refused(
        withPart({ type: 'image_url', image_url: { url: `data:application/pdf;base64,${PDF}` } }),
      ),
    ).toMatchObject({ message: expect.stringMatching(/Unsupported image type/) });
  });

  it('CH-5: a file id refers to a file stored in the named conversation (ADR 0062)', async () => {
    const stored = new Map<string, StoredFile>([
      [
        '01a0de3a-0000-7000-8000-000000000001',
        { mediaType: 'image/png', filename: 'cat.png', data: Buffer.from('fake png bytes') },
      ],
    ]);
    const asked: (readonly string[])[] = [];
    const lookUp: FileLookup = async (ids) => {
      asked.push(ids);
      return stored;
    };
    const { request } = await translateChatRequest(
      withPart({ type: 'file', file: { file_id: '01a0de3a-0000-7000-8000-000000000001' } }),
      lookUp,
    );
    expect(request.messages[0]?.content).toEqual([
      { type: 'file', mediaType: 'image/png', data: PNG, filename: 'cat.png' },
    ]);
    expect(asked).toEqual([['01a0de3a-0000-7000-8000-000000000001']]);

    // Another conversation's file, or anything else, is not there.
    expect(
      await refused(
        withPart({ type: 'file', file: { file_id: '01a0de3a-0000-7000-8000-000000000002' } }),
        lookUp,
      ),
    ).toMatchObject({
      param: 'messages[0].content[0].file.file_id',
      message: 'No file with this id is stored in the conversation.',
    });
    expect(
      await refused(withPart({ type: 'file', file: { file_id: 'file-123' } }), lookUp),
    ).toMatchObject({ param: 'messages[0].content[0].file.file_id' });
    // Without a conversation, a file id has nothing to refer to.
    expect(
      await refused(
        withPart({ type: 'file', file: { file_id: '01a0de3a-0000-7000-8000-000000000001' } }),
      ),
    ).toMatchObject({
      param: 'messages[0].content[0].file',
      message: expect.stringMatching(/x-lakka-conversation/),
    });
    // A request that refers to no files looks nothing up.
    asked.length = 0;
    await translateChatRequest(withPart({ type: 'text', text: 'hi' }), lookUp);
    expect(asked).toEqual([]);
  });

  it('CH-5: only user messages may carry files, and files have size limits', async () => {
    expect(
      (
        await refused({
          model: 'auto',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }],
            },
          ],
        })
      ).message,
    ).toMatch(/only user messages may carry files/);
    const big = Buffer.alloc(11 * 1024 * 1024).toString('base64');
    expect(
      (
        await refused({
          model: 'auto',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } }],
            },
          ],
        })
      ).message,
    ).toMatch(/larger than 10 MB/);
  });

  it('refuses a malformed body, naming the field', async () => {
    expect(await refused({ messages: [] })).toMatchObject({
      param: expect.stringMatching(/model|messages/),
    });
    expect(
      await refused({ model: 'auto', messages: [{ role: 'user', content: 'x' }], temperature: 5 }),
    ).toMatchObject({
      param: 'temperature',
    });
  });
});
