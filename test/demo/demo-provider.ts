import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

/*
 * Models and a tool server for the demo instance the tour's screenshots are taken from
 * (docker/compose.demo.yaml, ADR 0128). The acceptance suite's fake provider answers "Hello
 * there", which makes for empty screenshots, so this one answers each prompt of the story in
 * docs/design/docs/fixtures.md with a written reply, streamed word by word, and reports usage in
 * proportion to the text so traces and costs look like real traffic.
 *
 * Plain Node only: the container runs this file without the repository's packages.
 *
 *   :4020/anthropic/v1   Anthropic messages, with tool use for the support story
 *   :4020/openai/v1      OpenAI Responses
 *   :4020/google/v1beta  Google streamGenerateContent
 *   :4021/mcp            a helpdesk MCP server: search_tickets (read-only), close_ticket
 *                        (destructive, so Lakka asks before it runs)
 */

interface Script {
  match: RegExp;
  reply: string;
}

const SCRIPTS: Script[] = [
  {
    match: /filter box/i,
    reply: [
      'Same bug as the search hook: the timeout is never cleared, so every keystroke still ends ',
      'in a call to `onFilter`, just 250 ms late. Return the cleanup and list the callback:\n\n',
      '```ts\nuseEffect(() => {\n  const timer = setTimeout(() => onFilter(filter), 250);\n',
      '  return () => clearTimeout(timer);\n}, [filter, onFilter]);\n```',
    ].join(''),
  },
  {
    match: /debounce/i,
    reply: [
      'Two things to fix before this ships, and one nice-to-have.\n\n',
      '**1. The timer survives unmount.** If the component unmounts while a search is pending, ',
      '`onSearch` still fires and sets state on an unmounted tree. Clear it in the cleanup:\n\n',
      '```ts\nuseEffect(() => {\n  const timer = setTimeout(() => onSearch(query), delay);\n',
      '  return () => clearTimeout(timer);\n}, [query, delay, onSearch]);\n```\n\n',
      '**2. `onSearch` is a new function on every render** in the parent, so the effect re-runs ',
      'even when `query` has not changed. Wrap it in `useCallback` where it is defined.\n\n',
      '**Nice-to-have:** an `AbortController` per request, so a slow response for "inv" cannot ',
      'land after the one for "invoice".',
    ].join(''),
  },
  {
    match: /lower\(customer_email\)|query slow/i,
    reply: [
      'The `lower(customer_email)` call is the problem. An index on `customer_email` cannot be ',
      'used once the column is wrapped in a function, so Postgres scans every invoice.\n\n',
      'Add an expression index that matches the query:\n\n',
      '```sql\ncreate index concurrently invoices_customer_email_lower_idx\n',
      '  on invoices (lower(customer_email), created_at desc);\n```\n\n',
      'With `created_at desc` in the index the sort goes away too. Also select the columns you ',
      'need instead of `*`; the invoice PDFs are stored in that table.',
    ].join(''),
  },
  {
    match: /p95|p99/i,
    reply: [
      'p95 is the latency 95% of requests come in under; p99 is the same for 99%.\n\n',
      'With 10,000 requests a minute, p99 still describes 100 slow requests every minute, which ',
      'is why it is the one to alert on for anything user-facing. p95 is steadier and better for ',
      'dashboards and capacity planning.',
    ].join(''),
  },
  {
    match: /swedish|svenska/i,
    reply: [
      '**Nyheter i oktober**\n\n',
      'Du kan nu exportera fakturor som CSV direkt från kundsidan. Exporten följer de filter du ',
      'har valt, och stora exporter skickas till din e-post när de är klara.',
    ].join(''),
  },
  {
    match: /standup|stand-up/i,
    reply: [
      '**Yesterday:** finished the CSV export for invoices and fixed the date filter.\n\n',
      '**Today:** load-testing the export with 50,000 rows, then the review with Jonas.\n\n',
      '**Blocked:** nothing.',
    ].join(''),
  },
  {
    match: /changelog/i,
    reply:
      '**Invoices:** export the invoice list as CSV from the customer page. The export follows your filters; large ones are emailed when ready.',
  },
  {
    match: /failing test/i,
    reply: [
      '- `export.test.ts`: the CSV header order changed; update the snapshot.\n',
      '- `dates.test.ts`: fails only in the UTC+2 runner, a time zone assumption in the fixture.\n',
      '- Everything else passed (412 tests).',
    ].join(''),
  },
  {
    match: /survey answers/i,
    reply: [
      '| Theme | Answers |\n| --- | --- |\n| Export and reporting | 14 |\n| Speed | 9 |\n',
      '| Pricing | 6 |\n| Onboarding | 4 |',
    ].join(''),
  },
  {
    match: /reply to the customer/i,
    reply: 'Thanks for your patience. The invoice export fix is rolling out this week.',
  },
  {
    match: /churn|retention|cohort/i,
    reply: [
      'Group customers by the month they signed up, then for each month count how many are ',
      'still active 30, 60 and 90 days later. Divide by the cohort size and you have a ',
      'retention curve per cohort. If the September cohort drops faster than August at day 30, ',
      'look at what changed in onboarding that month first.',
    ].join(''),
  },
];

const DEFAULT_REPLY =
  'Here is a short answer. Ask me to go deeper on any part and I will walk through it step by step.';

/** The support story: find the tickets, then close the duplicate, then report. */
const SUPPORT = /invoice export/i;
const TICKETS = [
  { id: 'SUP-1482', title: 'Invoice export times out for large accounts', status: 'open' },
  { id: 'SUP-1490', title: 'Invoice CSV export never finishes', status: 'open' },
  { id: 'SUP-1471', title: 'Export button missing on invoices page', status: 'open' },
];
const SUPPORT_SUMMARY = [
  'I found three open tickets about invoice exports and closed one:\n\n',
  '| Ticket | Title | Now |\n| --- | --- | --- |\n',
  '| SUP-1482 | Invoice export times out for large accounts | open |\n',
  '| SUP-1490 | Invoice CSV export never finishes | closed, duplicate of SUP-1482 |\n',
  '| SUP-1471 | Export button missing on invoices page | open |\n\n',
  'SUP-1482 and SUP-1490 describe the same timeout, so I kept the older one open.',
].join('');
const SUPPORT_DECLINED = [
  'I found three open tickets about invoice exports. SUP-1490 looks like a duplicate of ',
  'SUP-1482 (both describe the export timing out), but you declined closing it, so all three ',
  'are still open. Tell me if you want a note added to SUP-1490 instead.',
].join('');

const tokens = (chars: number) => Math.max(1, Math.ceil(chars / 3.8));

/** A real provider takes a moment before its first token; traces should show one. */
const firstToken = () => sleep(380 + Math.random() * 300);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

const sse = (res: ServerResponse, data: unknown, event?: string) =>
  res.write(`${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`);

/** Every piece of text in a request, however the protocol nests it. */
function allText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(allText).join('\n');
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map(allText)
      .join('\n');
  }
  return '';
}

/** Words with their trailing space, so the reply streams as a person would see it typed. */
const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? [text];

function replyFor(prompt: string): string {
  return SCRIPTS.find((script) => script.match.test(prompt))?.reply ?? DEFAULT_REPLY;
}

/** The last user turn's text, which picks the reply. */
function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role === 'user') return allText(message.content);
  }
  return '';
}

// Anthropic messages ---------------------------------------------------------------------------

type AnthropicBlock = { type?: string; text?: string; content?: unknown };
type AnthropicMessage = { role?: string; content?: string | AnthropicBlock[] };

function toolResults(messages: AnthropicMessage[]): number {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((block) => block.type === 'tool_result').length;
}

function firstUserText(messages: AnthropicMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  return first === undefined ? '' : allText(first.content);
}

async function anthropic(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const model = String(body['model'] ?? '');
  const messages = (body['messages'] ?? []) as AnthropicMessage[];
  const offered = ((body['tools'] ?? []) as { name?: string }[]).map((t) => String(t.name ?? ''));
  const find = (short: string) => offered.find((n) => n === short || n.endsWith(`__${short}`));
  const inputTokens = tokens(allText(body['system']).length + allText(messages).length) + 120;

  let tool: { name: string; input: Record<string, unknown> } | undefined;
  let reply = replyFor(lastUserText(messages));
  if (SUPPORT.test(firstUserText(messages)) && offered.length > 0) {
    const done = toolResults(messages);
    const search = find('search_tickets');
    const close = find('close_ticket');
    if (done === 0 && search !== undefined) {
      tool = { name: search, input: { query: 'invoice export', status: 'open' } };
    } else if (done === 1 && close !== undefined) {
      tool = { name: close, input: { id: 'SUP-1490', reason: 'Duplicate of SUP-1482' } };
    } else {
      reply = /declined/i.test(allText(messages.at(-1)?.content))
        ? SUPPORT_DECLINED
        : SUPPORT_SUMMARY;
    }
  }

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  await firstToken();
  sse(
    res,
    {
      type: 'message_start',
      message: {
        id: `msg_${randomBytes(8).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    },
    'message_start',
  );
  let output: number;
  if (tool !== undefined) {
    const input = JSON.stringify(tool.input);
    sse(
      res,
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: `toolu_${randomBytes(8).toString('hex')}`,
          name: tool.name,
          input: {},
        },
      },
      'content_block_start',
    );
    sse(
      res,
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: input },
      },
      'content_block_delta',
    );
    output = tokens(input.length) + 20;
  } else {
    sse(
      res,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'content_block_start',
    );
    for (const word of words(reply)) {
      sse(
        res,
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } },
        'content_block_delta',
      );
      await sleep(18);
    }
    output = tokens(reply.length);
  }
  sse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
  sse(
    res,
    {
      type: 'message_delta',
      delta: { stop_reason: tool === undefined ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: output },
    },
    'message_delta',
  );
  res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
}

// OpenAI Responses -----------------------------------------------------------------------------

async function responses(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const model = String(body['model'] ?? '');
  const input = body['input'];
  const reply = replyFor(lastUserText(input) || allText(input));
  const response = {
    id: 'resp_demo',
    object: 'response',
    created_at: 1_790_000_000,
    model,
    output: [],
  };
  let seq = 0;
  const event = (type: string, data: Record<string, unknown>) =>
    sse(res, { type, sequence_number: seq++, ...data }, type);

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  await firstToken();
  event('response.created', { response: { ...response, status: 'in_progress' } });
  event('response.output_item.added', {
    output_index: 0,
    item: { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [] },
  });
  for (const word of words(reply)) {
    event('response.output_text.delta', {
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: word,
    });
    await sleep(18);
  }
  event('response.output_item.done', {
    output_index: 0,
    item: {
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: reply, annotations: [] }],
    },
  });
  const inputTokens = tokens(allText(body['instructions']).length + allText(input).length) + 120;
  const outputTokens = tokens(reply.length);
  event('response.completed', {
    response: {
      ...response,
      status: 'completed',
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: inputTokens + outputTokens,
      },
    },
  });
  res.end();
}

// Google -----------------------------------------------------------------------------------------

async function google(
  res: ServerResponse,
  url: string,
  body: Record<string, unknown>,
): Promise<void> {
  const model = decodeURIComponent(/\/models\/([^:]+):streamGenerateContent/.exec(url)?.[1] ?? '');
  const contents = (body['contents'] ?? []) as { role?: string; parts?: unknown }[];
  const lastUser = contents.findLast((c) => c.role === 'user');
  const reply = replyFor(allText(lastUser?.parts));
  const promptTokens =
    tokens(allText(body['systemInstruction']).length + allText(contents).length) + 120;
  const chunks = words(reply);

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  await firstToken();
  for (const [i, word] of chunks.entries()) {
    const last = i === chunks.length - 1;
    sse(res, {
      candidates: [
        {
          content: { parts: [{ text: word }], role: 'model' },
          index: 0,
          ...(last ? { finishReason: 'STOP' } : {}),
        },
      ],
      usageMetadata: last
        ? {
            promptTokenCount: promptTokens,
            candidatesTokenCount: tokens(reply.length),
            totalTokenCount: promptTokens + tokens(reply.length),
          }
        : { promptTokenCount: promptTokens, totalTokenCount: promptTokens },
      modelVersion: model,
    });
    await sleep(18);
  }
  res.end();
}

// The helpdesk MCP server ----------------------------------------------------------------------

const HELPDESK_TOOLS = [
  {
    name: 'search_tickets',
    title: 'Search tickets',
    description: 'Finds support tickets by text and status.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        status: { type: 'string', enum: ['open', 'closed', 'any'] },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'close_ticket',
    title: 'Close ticket',
    description: 'Closes a support ticket with a reason the customer can see.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, reason: { type: 'string' } },
      required: ['id', 'reason'],
    },
    annotations: { destructiveHint: true },
  },
];

const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

function helpdesk(message: {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}) {
  const params = message.params ?? {};
  let result: unknown;
  switch (message.method) {
    case 'initialize':
      result = {
        protocolVersion: params['protocolVersion'],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'helpdesk', version: '1.0.0' },
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: HELPDESK_TOOLS };
      break;
    case 'tools/call': {
      const args = (params['arguments'] ?? {}) as Record<string, unknown>;
      result =
        params['name'] === 'search_tickets'
          ? text(JSON.stringify(TICKETS))
          : text(`Closed ${String(args['id'] ?? '')}.`);
      break;
    }
    default:
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      };
  }
  return { jsonrpc: '2.0', id: message.id, result };
}

// Servers --------------------------------------------------------------------------------------

const models = createServer((req, res) => {
  void (async () => {
    const url = req.url ?? '';
    if (req.method === 'GET') {
      // Connection tests list models; any list will do.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [], models: [] }));
      return;
    }
    const body = await readJson(req);
    if (url.startsWith('/anthropic/')) return anthropic(res, body);
    if (url.startsWith('/openai/')) return responses(res, body);
    if (url.startsWith('/google/')) return google(res, url, body);
    res.writeHead(404).end();
  })().catch(() => res.socket?.destroy());
});

const tools = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const message = (await readJson(req)) as { id?: string | number; method: string };
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(helpdesk(message)));
  })().catch(() => res.writeHead(400).end());
});

// Nordlys SSO: registering a sign-in provider reads its discovery document, so this answers as
// the issuer. Nobody signs in through it; the demo's people use passwords.
const SSO_ISSUER = 'http://login.nordlys.example';
const sso = createServer((req, res) => {
  const path = new URL(req.url ?? '/', SSO_ISSUER).pathname;
  res.writeHead(200, { 'content-type': 'application/json' });
  if (path === '/.well-known/openid-configuration') {
    res.end(
      JSON.stringify({
        issuer: SSO_ISSUER,
        authorization_endpoint: `${SSO_ISSUER}/authorize`,
        token_endpoint: `${SSO_ISSUER}/token`,
        userinfo_endpoint: `${SSO_ISSUER}/userinfo`,
        jwks_uri: `${SSO_ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      }),
    );
    return;
  }
  res.end(JSON.stringify({ keys: [] }));
});

models.listen(Number(process.env['DEMO_PROVIDER_PORT'] ?? 4020), '0.0.0.0');
tools.listen(Number(process.env['DEMO_MCP_PORT'] ?? 4021), '0.0.0.0');
sso.listen(Number(process.env['DEMO_SSO_PORT'] ?? 80), '0.0.0.0');
process.stdout.write('demo provider on :4020, helpdesk MCP server on :4021, SSO on :80\n');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => process.exit(0));
}
