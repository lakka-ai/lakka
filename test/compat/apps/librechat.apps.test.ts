import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readState } from '../state.ts';
import type { CompatState } from '../state.ts';
import { setWorkspaceCap, sseData } from './support.ts';

/*
 * An unmodified LibreChat with Lakka as a custom endpoint (API-6, ADR 0064), driven through
 * its own HTTP API, which is what its interface calls. A message is posted, then its reply
 * streamed from a second endpoint; LibreChat refuses chat requests without a browser's
 * User-Agent, so the checks send one.
 */

const LIBRECHAT = process.env['LAKKA_COMPAT_LIBRECHAT_URL'] ?? 'http://127.0.0.1:3080';
const ENDPOINT = 'lakka';
const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const NO_PARENT = '00000000-0000-0000-0000-000000000000';

let state: CompatState;
let token: string;

const headers = () => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  'user-agent': BROWSER,
});

interface Final {
  final: true;
  conversation: { conversationId: string };
  responseMessage: {
    messageId: string;
    content?: { type: string; text?: string; error?: string }[];
  };
}

/** Sends one message and reads LibreChat's streamed reply to its final event. */
async function send(
  text: string,
  model: string,
  thread: { conversationId: string; parentMessageId: string } = {
    conversationId: 'new',
    parentMessageId: NO_PARENT,
  },
): Promise<{ deltas: string; final: Final }> {
  const posted = await fetch(`${LIBRECHAT}/api/agents/chat/${ENDPOINT}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ endpoint: ENDPOINT, endpointType: 'custom', model, text, ...thread }),
  });
  expect(posted.status).toBe(200);
  const { streamId } = (await posted.json()) as { streamId: string };
  const stream = await fetch(`${LIBRECHAT}/api/agents/chat/stream/${streamId}`, {
    headers: headers(),
  });
  expect(stream.status).toBe(200);
  let deltas = '';
  let final: Final | undefined;
  for (const frame of sseData(await stream.text()) as Record<string, unknown>[]) {
    if (frame['event'] === 'on_message_delta') {
      const content = (frame['data'] as { delta?: { content?: { text?: string }[] } }).delta
        ?.content;
      deltas += (content ?? []).map((c) => c.text ?? '').join('');
    }
    if (frame['final'] === true) final = frame as unknown as Final;
  }
  if (final === undefined) throw new Error('the stream ended without a final event');
  return { deltas, final };
}

const replyText = (final: Final) =>
  (final.responseMessage.content ?? []).map((c) => c.text ?? '').join('');

beforeAll(async () => {
  state = readState();
  const email = `compat-${randomBytes(3).toString('hex')}@example.com`;
  const password = `compat password ${randomBytes(4).toString('hex')}`;
  const registered = await fetch(`${LIBRECHAT}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': BROWSER },
    body: JSON.stringify({ name: 'Compat Tester', email, password, confirm_password: password }),
  });
  if (!registered.ok) throw new Error(`LibreChat registration failed: ${registered.status}`);
  const login = await fetch(`${LIBRECHAT}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': BROWSER },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`LibreChat login failed: ${login.status}`);
  token = ((await login.json()) as { token: string }).token;
});

afterAll(async () => {
  await setWorkspaceCap(state, null).catch(() => undefined);
});

describe('LibreChat (API-6)', () => {
  it('API-6: lists the models it fetched from Lakka, not its fallback list', async () => {
    const res = await fetch(`${LIBRECHAT}/api/models`, { headers: headers() });
    expect(res.status).toBe(200);
    const models = ((await res.json()) as Record<string, string[]>)[ENDPOINT] ?? [];
    expect(models).toEqual(
      expect.arrayContaining(['auto', `route/${state.route}`, ...Object.values(state.models)]),
    );
    expect(models).not.toContain('not-from-lakka');
  });

  it('API-6: holds a streaming conversation over two turns, which it keeps', async () => {
    const first = await send('Hello', state.models.ok);
    expect(first.deltas).toBe('Hello there');
    expect(replyText(first.final)).toBe('Hello there');
    const thread = {
      conversationId: first.final.conversation.conversationId,
      parentMessageId: first.final.responseMessage.messageId,
    };
    const second = await send('And again?', state.models.ok, thread);
    expect(replyText(second.final)).toBe('Hello there');
    const history = await fetch(`${LIBRECHAT}/api/messages/${thread.conversationId}`, {
      headers: headers(),
    });
    expect(((await history.json()) as unknown[]).length).toBe(4);
  });

  it("API-6: Lakka's budgets apply: over the cap, the reply is an error that says so", async () => {
    await setWorkspaceCap(state, '1');
    try {
      const { final } = await send('Hello', state.models.ok);
      const errors = (final.responseMessage.content ?? []).filter((c) => c.type === 'error');
      expect(errors.map((e) => e.error).join(' ')).toMatch(/402/);
    } finally {
      await setWorkspaceCap(state, null);
    }
  });
});
