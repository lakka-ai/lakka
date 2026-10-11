import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/*
 * A model provider that misbehaves on request, for dispatch tests. It speaks the
 * OpenAI chat completions streaming protocol under /openai/v1 and Anthropic's messages protocol
 * under /anthropic/v1, each with every behaviour below. For the M2 gate it also answers "ok"
 * in OpenAI's Responses protocol under /responses/v1 and Google's under /google/v1beta, so every
 * provider kind can be dispatched end to end. What it does is chosen by the requested model
 * name, so parallel tests never share state:
 *
 *   ok                 streams "Hello there" and reports usage
 *   slow               streams 40 chunks, 25 ms apart
 *   markdown           streams a long Markdown reply (headings, a list, code, a table, a link),
 *                      a line every 60 ms, long enough to scroll while it is still coming
 *   no-usage           streams text but never reports usage
 *   status-<code>      answers with that HTTP status (429 adds -ra<seconds> for Retry-After)
 *   context-overflow   400, the provider's "input too long" error
 *   content-filter     400, a content policy refusal
 *   bad-request        400, anything else
 *   stall              sends headers, then nothing
 *   drop-before-first  sends headers, then closes the connection
 *   drop-after-2       sends two chunks, then closes the connection
 *   idle-after-1       sends one chunk, then goes quiet
 *   error-event        (Anthropic) an overloaded_error event before any content
 *   flaky-<n>-<rest>   behaves like <rest> for the first n requests, then like ok
 *
 * Tool scenarios (OpenAI protocol only, M6), which answer from what the request carries:
 *
 *   tool-<a>.<b>       with tools offered and no results yet, calls each named tool once, in one
 *                      round (a tool matches by its name or its <server>__ suffix); once results
 *                      are back, or with no tools, answers "Tool said: <the results>"
 *   tool-repeat        calls echo with the same arguments every round while tools are offered
 *   tool-forever       calls echo with new arguments every round while tools are offered
 *   toolthen-<a>-<rest>  calls tool <a> like tool-<a>; once its result is back, behaves like
 *                      <rest> (for example toolthen-echo-drop-after-2 breaks the second round)
 *
 * Anything after "~" is ignored, so each test can use a name of its own.
 */

export interface ProviderRequestLog {
  protocol: 'openai' | 'anthropic' | 'responses' | 'google';
  model: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

export interface FakeProvider {
  url: string;
  requests: ProviderRequestLog[];
  /** How many requests reached this model name. */
  count(model: string): number;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const sse = (res: ServerResponse, data: unknown, event?: string) =>
  res.write(`${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`);

function openaiChunk(model: string, delta: object, finish: string | null = null) {
  return {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1_790_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** The markdown scenario's reply, one line per chunk. */
const MARKDOWN_REPLY = [
  '# Release notes\n\n',
  'This reply has **bold**, *italic* and `inline code`.\n\n',
  '## Changes\n\n',
  '- First change\n',
  '- Second change\n',
  '- Third change\n\n',
  '```python\nprint("hello")\n```\n\n',
  '| Model | Cost |\n| --- | --- |\n| small | $0.01 |\n\n',
  'Read [the docs](https://example.com/docs).\n\n',
  ...Array.from(
    { length: 50 },
    (_, i) => `Paragraph ${i + 1} of the reply, long enough to scroll.\n\n`,
  ),
  'The end.',
];

async function streamOpenai(
  res: ServerResponse,
  model: string,
  texts: string[],
  usage: boolean,
  gapMs: number,
) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [i, text] of texts.entries()) {
    sse(
      res,
      openaiChunk(model, i === 0 ? { role: 'assistant', content: text } : { content: text }),
    );
    await sleep(gapMs);
  }
  sse(res, openaiChunk(model, {}, 'stop'));
  if (usage) {
    sse(res, {
      ...openaiChunk(model, {}),
      choices: [],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 8,
        total_tokens: 58,
        prompt_tokens_details: { cached_tokens: 32 },
      },
    });
  }
  res.end('data: [DONE]\n\n');
}

async function streamAnthropic(
  res: ServerResponse,
  model: string,
  texts: string[],
  usage: boolean,
  gapMs: number,
) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(
    res,
    {
      type: 'message_start',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: usage
          ? {
              input_tokens: 12,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 2000,
              output_tokens: 1,
            }
          : { input_tokens: 0, output_tokens: 0 },
      },
    },
    'message_start',
  );
  sse(
    res,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    'content_block_start',
  );
  for (const text of texts) {
    sse(
      res,
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      'content_block_delta',
    );
    await sleep(gapMs);
  }
  sse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
  sse(
    res,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 },
    },
    'message_delta',
  );
  res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
}

const TOOL_ARGUMENTS: Record<string, (round: number) => Record<string, unknown>> = {
  echo: () => ({ text: 'hi' }),
  delete: () => ({ id: '42' }),
  whoami: () => ({}),
  sandbox: () => ({}),
};

type OpenaiMessage = { role?: string; content?: unknown };

/** What a tool scenario does next: call tools, or answer in text. */
function toolPlan(
  scenario: string,
  body: Record<string, unknown>,
): { calls: { name: string; arguments: string }[] } | { text: string } {
  const offered = ((body['tools'] ?? []) as { function?: { name?: string } }[]).map((tool) =>
    String(tool.function?.name ?? ''),
  );
  const messages = (body['messages'] ?? []) as OpenaiMessage[];
  const results: string[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i]?.role === 'tool'; i -= 1) {
    results.unshift(String(messages[i]?.content ?? ''));
  }
  const rounds = messages.filter((m) => m.role === 'tool').length;
  const find = (short: string) =>
    offered.find((name) => name === short || name.endsWith(`__${short}`));
  const answer = { text: `Tool said: ${results.join(' | ')}` };
  if (offered.length === 0) return answer;
  const wanted =
    scenario === 'tool-repeat' || scenario === 'tool-forever'
      ? ['echo']
      : results.length > 0
        ? []
        : scenario.slice('tool-'.length).split('.');
  const calls = wanted.flatMap((short) => {
    const name = find(short);
    if (name === undefined) return [];
    const args =
      scenario === 'tool-forever'
        ? { text: `round ${rounds}` }
        : (TOOL_ARGUMENTS[short]?.(rounds) ?? {});
    return [{ name, arguments: JSON.stringify(args) }];
  });
  return calls.length === 0 ? answer : { calls };
}

async function streamToolPlan(
  res: ServerResponse,
  model: string,
  plan: ReturnType<typeof toolPlan>,
): Promise<void> {
  if ('text' in plan) return streamOpenai(res, model, [plan.text], true, 1);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, openaiChunk(model, { role: 'assistant', content: null }));
  for (const [index, call] of plan.calls.entries()) {
    const id = `call_${randomBytes(6).toString('hex')}`;
    sse(
      res,
      openaiChunk(model, {
        tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: '' } }],
      }),
    );
    sse(
      res,
      openaiChunk(model, { tool_calls: [{ index, function: { arguments: call.arguments } }] }),
    );
    await sleep(1);
  }
  sse(res, openaiChunk(model, {}, 'tool_calls'));
  sse(res, {
    ...openaiChunk(model, {}),
    choices: [],
    usage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 },
  });
  res.end('data: [DONE]\n\n');
}

function errorBody(protocol: 'openai' | 'anthropic', kind: string, message: string, code?: string) {
  return protocol === 'openai'
    ? { error: { message, type: kind, code: code ?? null } }
    : { type: 'error', error: { type: kind, message } };
}

/** Listens on 127.0.0.1 and a free port unless told otherwise, as the acceptance stack does. */
export async function startFakeProvider(
  listen: { host?: string; port?: number } = {},
): Promise<FakeProvider> {
  const requests: ProviderRequestLog[] = [];
  const counts = new Map<string, number>();
  const sockets = new Set<Socket>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      return;
    }
    if (url.startsWith('/responses/') || url.startsWith('/google/')) {
      await okInOtherProtocol(req, res, url);
      return;
    }
    const protocol = url.startsWith('/anthropic/') ? 'anthropic' : 'openai';
    const body = await readJson(req);
    const model = String(body['model'] ?? '');
    requests.push({
      protocol,
      model,
      authorization: req.headers.authorization ?? req.headers['x-api-key']?.toString(),
      body,
    });
    const seen = (counts.get(model) ?? 0) + 1;
    counts.set(model, seen);

    let scenario = model.split('~')[0] ?? '';
    const flaky = /^flaky-(\d+)-(.+)$/.exec(scenario);
    if (flaky !== null) scenario = seen <= Number(flaky[1]) ? (flaky[2] ?? 'ok') : 'ok';

    const stream = protocol === 'openai' ? streamOpenai : streamAnthropic;
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };

    const status = /^status-(\d{3})(?:-ra(\d+))?$/.exec(scenario);
    if (status !== null) {
      const code = Number(status[1]);
      const headers: Record<string, string> =
        status[2] === undefined ? {} : { 'retry-after': status[2] };
      json(
        code,
        errorBody(protocol, code === 429 ? 'rate_limit_error' : 'api_error', `status ${code}`),
        headers,
      );
      return;
    }
    const toolThen = /^toolthen-([a-z]+)-(.+)$/.exec(scenario);
    if (toolThen !== null && protocol === 'openai') {
      const plan = toolPlan(`tool-${toolThen[1] ?? ''}`, body);
      if ('calls' in plan) return streamToolPlan(res, model, plan);
      scenario = toolThen[2] ?? 'ok';
    }
    if (scenario.startsWith('tool-') && protocol === 'openai') {
      return streamToolPlan(res, model, toolPlan(scenario, body));
    }
    switch (scenario) {
      case 'ok':
        return stream(res, model, ['Hello', ' there'], true, 5);
      case 'markdown':
        return stream(res, model, MARKDOWN_REPLY, true, 60);
      case 'slow':
        return stream(
          res,
          model,
          Array.from({ length: 40 }, (_, i) => `w${i} `),
          true,
          25,
        );
      case 'no-usage':
        return stream(res, model, ['Hello', ' there'], false, 5);
      case 'context-overflow':
        return json(
          400,
          protocol === 'openai'
            ? errorBody(
                protocol,
                'invalid_request_error',
                'This model maximum context length is 8192 tokens',
                'context_length_exceeded',
              )
            : errorBody(
                protocol,
                'invalid_request_error',
                'prompt is too long: 250000 tokens > 200000 maximum',
              ),
        );
      case 'content-filter':
        return json(
          400,
          errorBody(
            protocol,
            'invalid_request_error',
            'Refused by the content policy',
            'content_policy_violation',
          ),
        );
      case 'bad-request':
        return json(
          400,
          errorBody(protocol, 'invalid_request_error', 'temperature is out of range'),
        );
      case 'stall':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        return;
      case 'drop-before-first':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        await sleep(10);
        res.socket?.destroy();
        return;
      case 'drop-after-2':
      case 'idle-after-1': {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const n = scenario === 'drop-after-2' ? 2 : 1;
        if (protocol === 'openai') {
          for (let i = 0; i < n; i += 1) {
            sse(
              res,
              openaiChunk(
                model,
                i === 0 ? { role: 'assistant', content: 'part ' } : { content: 'part ' },
              ),
            );
            await sleep(5);
          }
        } else {
          sse(
            res,
            {
              type: 'message_start',
              message: {
                id: 'm',
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            },
            'message_start',
          );
          sse(
            res,
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            'content_block_start',
          );
          for (let i = 0; i < n; i += 1) {
            sse(
              res,
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'part ' },
              },
              'content_block_delta',
            );
            await sleep(5);
          }
        }
        if (scenario === 'drop-after-2') {
          await sleep(10);
          res.socket?.destroy();
        }
        return;
      }
      case 'error-event':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(
          res,
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
          'error',
        );
        res.end();
        return;
      default:
        json(
          404,
          errorBody(protocol, 'not_found_error', `unknown model ${model}`, 'model_not_found'),
        );
    }
  }

  /** "ok" in OpenAI's Responses protocol or Google's, with cached and reasoning tokens. */
  async function okInOtherProtocol(req: IncomingMessage, res: ServerResponse, url: string) {
    const body = await readJson(req);
    const google = url.startsWith('/google/');
    const model = google
      ? decodeURIComponent(/\/models\/([^:]+):streamGenerateContent/.exec(url)?.[1] ?? '')
      : String(body['model'] ?? '');
    requests.push({
      protocol: google ? 'google' : 'responses',
      model,
      authorization: req.headers.authorization ?? req.headers['x-goog-api-key']?.toString(),
      body,
    });
    counts.set(model, (counts.get(model) ?? 0) + 1);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (google) {
      sse(res, {
        candidates: [{ content: { parts: [{ text: 'Hello' }], role: 'model' }, index: 0 }],
        usageMetadata: { promptTokenCount: 1500, totalTokenCount: 1500 },
        modelVersion: model,
      });
      sse(res, {
        candidates: [
          {
            content: { parts: [{ text: ' there' }], role: 'model' },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 1500,
          cachedContentTokenCount: 1000,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 50,
          totalTokenCount: 1570,
        },
        modelVersion: model,
      });
      res.end();
      return;
    }
    const response = {
      id: 'resp_1',
      object: 'response',
      created_at: 1_790_000_000,
      model,
      output: [],
    };
    sse(
      res,
      {
        type: 'response.created',
        sequence_number: 0,
        response: { ...response, status: 'in_progress' },
      },
      'response.created',
    );
    sse(
      res,
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_1',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      },
      'response.output_item.added',
    );
    for (const [i, delta] of ['Hello', ' there'].entries()) {
      sse(
        res,
        {
          type: 'response.output_text.delta',
          sequence_number: 2 + i,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta,
        },
        'response.output_text.delta',
      );
    }
    sse(
      res,
      {
        type: 'response.output_item.done',
        sequence_number: 4,
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_1',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello there', annotations: [] }],
        },
      },
      'response.output_item.done',
    );
    sse(
      res,
      {
        type: 'response.completed',
        sequence_number: 5,
        response: {
          ...response,
          status: 'completed',
          usage: {
            input_tokens: 2100,
            input_tokens_details: { cached_tokens: 2000 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 30 },
            total_tokens: 2140,
          },
        },
      },
      'response.completed',
    );
    res.end();
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => res.socket?.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const host = listen.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(listen.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    requests,
    count: (model) => counts.get(model) ?? 0,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
