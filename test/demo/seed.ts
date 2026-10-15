import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import catalogue from '../../packages/core/catalogue/models.json' with { type: 'json' };

/*
 * Fills a fresh demo stack (docker/compose.demo.yaml) with the story of
 * docs/design/docs/fixtures.md, for the tour's screenshots (ADR 0128). Everything a screen shows
 * about a single request (chat, traces, tool calls, the move to a cheaper model, a refusal) comes
 * from real requests through the API, answered by test/demo/demo-provider.ts. Only the spend
 * history behind the charts and caps is written to Postgres directly: no demo can send six
 * thousand requests, and those rows are the one part of the story the budget engine did not
 * produce.
 *
 * Changes from the fixtures: every address is under nordlys.example, so no screenshot names a
 * real domain, and the models are current catalogue models.
 */

const BASE = process.env['LAKKA_DEMO_URL'] ?? 'http://127.0.0.1:8090';
/** LAKKA_PUBLIC_URL in compose.demo.yaml: the origin check compares against it. */
const ORIGIN = 'http://ai.nordlys.example';
const COMPOSE = [
  'compose',
  '-p',
  'lakka-demo',
  '-f',
  'compose.yaml',
  '-f',
  'docker/compose.demo.yaml',
];
export const STATE_FILE = 'test/demo/.state.json';

const DEMO_MODELS = 'http://demo-provider:4020';
const HELPDESK_ORIGIN = 'http://demo-provider:4021';

const SONNET = 'anthropic:claude-sonnet-5-5';
const HAIKU = 'anthropic:claude-haiku-5-5';
const OPUS = 'anthropic:claude-opus-5-5';
const FLASH = 'google:gemini-3.8-flash';
const GPT = 'openai:gpt-5-mini';

const say = (line: string) => process.stdout.write(`${line}\n`);
const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));

// Plumbing -------------------------------------------------------------------------------------

function docker(args: string[], input?: string): string {
  return execFileSync('docker', [...COMPOSE, ...args], {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function psql(sql: string): string {
  return docker(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'lakka',
      '-d',
      'lakka',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atq',
    ],
    sql,
  );
}

const lit = (value: string | null) =>
  value === null ? 'null' : `'${value.replaceAll("'", "''")}'`;

class Session {
  cookie = '';

  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const res = await this.raw(method, path, body, headers);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
    return (text === '' ? {} : JSON.parse(text)) as T;
  }

  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie === '' ? {} : { cookie: this.cookie }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');
    if (set.length > 0) this.cookie = set.join('; ');
    return res;
  }
}

async function signIn(email: string, password: string): Promise<Session> {
  const session = new Session();
  for (let attempt = 0; ; attempt += 1) {
    const res = await session.raw('POST', '/api/auth/sign-in/email', { email, password });
    if (res.ok) return session;
    // Sign-in allows three attempts per address per ten seconds.
    if (res.status !== 429 || attempt > 5) throw new Error(`sign-in for ${email}: ${res.status}`);
    await sleep(4000);
  }
}

/** A uuidv7 for rows written directly, as the app's own rows are (time-ordered). */
function uuidv7(at: number): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(at, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The same seed gives the same history, so screenshots only change when the UI does.
let state = 0x9e3779b9;
function random(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo: number, hi: number) => lo + random() * (hi - lo);
const logBetween = (lo: number, hi: number) =>
  Math.round(Math.exp(between(Math.log(lo), Math.log(hi))));
function pick<T>(weighted: readonly (readonly [T, number])[]): T {
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  let r = random() * total;
  for (const [value, w] of weighted) {
    r -= w;
    if (r <= 0) return value;
  }
  const last = weighted.at(-1);
  if (last === undefined) throw new Error('nothing to pick from');
  return last[0];
}

// The story ------------------------------------------------------------------------------------

interface Person {
  key: string;
  name: string;
  email: string;
  /** Signs in with a password only; everyone else also has Nordlys SSO. */
  password?: true;
  id?: string;
  secret?: string;
}

const PEOPLE: Person[] = [
  { key: 'maja', name: 'Maja Lind', email: 'maja@nordlys.example' },
  { key: 'jonas', name: 'Jonas Ek', email: 'jonas@nordlys.example' },
  { key: 'erik', name: 'Erik Holm', email: 'erik.holm@nordlys.example' },
  { key: 'sara', name: 'Sara Nyberg', email: 'sara@nordlys.example', password: true },
  { key: 'lina', name: 'Lina Berg', email: 'lina@nordlys.example' },
  { key: 'nils', name: 'Nils Strand', email: 'nils@nordlys.example', password: true },
  { key: 'anna', name: 'Anna Virtanen', email: 'anna@nordlys.example' },
  { key: 'per', name: 'Per Olsen', email: 'per@nordlys.example' },
  { key: 'oskar', name: 'Oskar Dahl', email: 'oskar@nordlys.example' },
  { key: 'elin', name: 'Elin Wallin', email: 'elin@nordlys.example' },
  { key: 'johan', name: 'Johan Nord', email: 'johan@nordlys.example' },
  { key: 'karin', name: 'Karin Ahl', email: 'karin@nordlys.example' },
  { key: 'fredrik', name: 'Fredrik Lunde', email: 'fredrik@nordlys.example' },
  { key: 'sofia', name: 'Sofia Hedman', email: 'sofia@nordlys.example' },
  { key: 'henrik', name: 'Henrik Berglund', email: 'henrik@nordlys.example' },
  { key: 'ida', name: 'Ida Falk', email: 'ida@nordlys.example' },
  { key: 'hanna', name: 'Hanna Lund', email: 'hanna@nordlys.example' },
  { key: 'mikael', name: 'Mikael Wik', email: 'mikael@nordlys.example' },
  { key: 'tove', name: 'Tove Ekman', email: 'tove@nordlys.example' },
  { key: 'emma', name: 'Emma Kvist', email: 'emma@nordlys.example' },
  { key: 'viktor', name: 'Viktor Sand', email: 'viktor@nordlys.example' },
  { key: 'johanna', name: 'Johanna Lindqvist', email: 'johanna@nordlys.example' },
  { key: 'aron', name: 'Aron Mattsson', email: 'aron@nordlys.example' },
  { key: 'linnea', name: 'Linnea Borg', email: 'linnea@nordlys.example' },
  { key: 'petra', name: 'Petra Nyman', email: 'petra@nordlys.example' },
  { key: 'daniel', name: 'Daniel Ost', email: 'daniel@nordlys.example' },
  { key: 'kalle', name: 'Kalle Rydberg', email: 'kalle@nordlys.example' },
  { key: 'mira', name: 'Mira Holmberg', email: 'mira@nordlys.example' },
  { key: 'tomas', name: 'Tomas Engel', email: 'tomas@nordlys.example' },
  { key: 'ella', name: 'Ella Sundin', email: 'ella@nordlys.example' },
  { key: 'gustav', name: 'Gustav Brandt', email: 'gustav@nordlys.example' },
];
const person = (key: string): Person & { id: string } => {
  const found = PEOPLE.find((p) => p.key === key);
  if (found?.id === undefined) throw new Error(`no person ${key}`);
  return found as Person & { id: string };
};

const PRODUCT_MEMBERS = [
  'jonas',
  'erik',
  'sara',
  'lina',
  'nils',
  'anna',
  'oskar',
  'elin',
  'johan',
  'karin',
  'fredrik',
  'sofia',
  'henrik',
  'linnea',
  'daniel',
  'kalle',
  'ella',
];
const SUPPORT_MEMBERS = ['sara', 'erik', 'ida', 'hanna', 'mikael', 'tove', 'petra', 'tomas'];
const DESIGN_MEMBERS = ['emma', 'viktor', 'johanna', 'aron', 'mira'];

/** Spend this month and last, in dollars, by workspace and person; keys are counted apart. */
const SPEND = {
  product: {
    cur: {
      maja: 121.2,
      jonas: 214.35,
      erik: 164.1,
      sara: 91.35,
      lina: 88.05,
      nils: 58.9,
      oskar: 21.4,
      elin: 18.75,
      johan: 16.2,
      karin: 14.9,
      fredrik: 13.35,
      sofia: 12.8,
      henrik: 15.6,
      linnea: 11.25,
      daniel: 17.3,
      kalle: 5.85,
      ella: 10.25,
      anna: 12.4,
    },
    prev: {
      maja: 168.4,
      jonas: 201.1,
      erik: 152.3,
      sara: 118.6,
      lina: 79.5,
      nils: 61.2,
      oskar: 19.8,
      elin: 22.4,
      johan: 14.6,
      karin: 16.1,
      fredrik: 11.9,
      sofia: 13.7,
      henrik: 12.2,
      linnea: 9.8,
      daniel: 8.4,
      kalle: 7.7,
      ella: 6.9,
      anna: 6.6,
    },
  },
  support: {
    cur: {
      per: 61.3,
      sara: 54.2,
      erik: 41.9,
      ida: 72.4,
      hanna: 66.75,
      mikael: 38.6,
      tove: 29.35,
      petra: 23.3,
      tomas: 0,
    },
    prev: {
      per: 58.1,
      sara: 49.6,
      erik: 44.2,
      ida: 70.3,
      hanna: 61.8,
      mikael: 35.9,
      tove: 31.4,
      petra: 22.15,
      tomas: 14.7,
    },
  },
  design: {
    cur: { maja: 18.4, emma: 61.2, viktor: 52.35, johanna: 44.8, aron: 31.6, mira: 21.35 },
    prev: { maja: 12.1, emma: 55.4, viktor: 49.3, johanna: 41.2, aron: 27.6, mira: 19.0 },
  },
} as const;
/** Through keys: CI bot (Maja, Product), Notebook (Sara, Product), Support macros (Erik, Support). */
const KEY_SPEND = {
  ciBot: { cur: 61.2, prev: 74.3 },
  notebook: { cur: 30.4, prev: 18.2 },
  macros: { cur: 25 },
};
/** Nils's daily cap: what he has spent today. */
const NILS_TODAY = 2.15;

// Seeding --------------------------------------------------------------------------------------

interface Workspace {
  id: string;
}

async function setup(): Promise<Session> {
  const status = await new Session().call<{ required: boolean }>('GET', '/api/setup');
  if (!status.required) {
    throw new Error(
      'This stack is already set up. The seed needs a fresh one:\n' +
        '  docker compose -p lakka-demo -f compose.yaml -f docker/compose.demo.yaml down -v',
    );
  }
  const code = docker(['exec', '-T', 'api', 'lakka', 'setup-code']).trim().split('\n').at(-1) ?? '';
  const maja = PEOPLE[0];
  if (maja?.key !== 'maja') throw new Error('Maja comes first: she runs the first-run setup');
  maja.secret = `demo ${randomBytes(9).toString('base64url')}`;
  const session = new Session();
  await session.call('POST', '/api/setup/secrets', { code });
  const { workspace } = await session.call<{ workspace: Workspace }>('POST', '/api/setup', {
    code,
    admin: { name: maja.name, email: maja.email, password: maja.secret },
    workspace: { name: 'Product', slug: 'product' },
  });
  maja.id = psql(`select id from principals where email = ${lit(maja.email)}`).trim();
  products.id = workspace.id;
  return session;
}

/** The workspace first-run setup makes; its id is filled in then. */
const products: Workspace = { id: '' };

function createPeople(): void {
  for (const p of PEOPLE) {
    if (p.id !== undefined) continue;
    p.secret = `demo ${randomBytes(9).toString('base64url')}`;
    const out = docker(
      ['exec', '-T', 'api', 'lakka', 'create-user', '--email', p.email, '--name', p.name],
      `${p.secret}\n`,
    );
    p.id = out.trim().split('\n').at(-1) ?? '';
  }
}

async function providers(admin: Session): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [kind, path] of [
    ['anthropic', '/anthropic/v1'],
    ['openai', '/openai/v1'],
    ['google', '/google/v1beta'],
  ] as const) {
    const { provider } = await admin.call<{ provider: { id: string } }>('POST', '/api/providers', {
      kind,
      baseUrl: `${DEMO_MODELS}${path}`,
      // The demo server accepts any key.
      apiKey: `demo-${kind}-key`,
    });
    await admin.call('POST', `/api/providers/${provider.id}/test`);
    ids[kind] = provider.id;
  }
  return ids;
}

async function createWorkspace(
  admin: Session,
  name: string,
  slug: string,
  adminKey: string,
): Promise<Workspace> {
  const { workspace: ws } = await admin.call<{ workspace: Workspace }>('POST', '/api/workspaces', {
    name,
    slug,
    adminPrincipalId: person(adminKey).id,
  });
  return ws;
}

async function members(admin: Session, ws: Workspace, keys: readonly string[], role = 'member') {
  for (const key of keys) {
    await admin.call('PUT', `/api/workspaces/${ws.id}/members/${person(key).id}`, { role });
  }
}

const CODE_EXAMPLES = [
  'Why does this function return undefined when the array is empty?',
  'Write a bash script that deletes log files older than 30 days.',
  'Can you review this pull request description and the diff below for bugs?',
  'How do I undo my last commit without losing the changes?',
  'This SQL query takes 40 seconds on a big table, how do I make it faster?',
  'Explain what this stack trace means and where I should start looking.',
  'Add input validation to this form handler so empty emails are rejected.',
  'Write unit tests for the date parsing helper below.',
  'Convert this Python 2 code to Python 3.',
  'What is the difference between a process and a thread?',
  'I keep getting CORS errors when the frontend calls our API locally, what am I missing?',
  'Our Docker build is suddenly twice as slow, what could cause that?',
];
const WRITING_EXAMPLES = [
  'Write a short update for the team about the release slipping a week.',
  'Draft my standup notes from these bullet points.',
  'Rewrite this paragraph so it sounds friendlier.',
  'Help me write a job ad for a senior backend engineer.',
  'Turn these notes into a short blog post for customers.',
  'Write a polite reply declining the meeting invite.',
  'Make this release announcement shorter and clearer.',
  'Draft an email to a customer explaining the outage.',
  'Write the intro for our quarterly product update.',
  'Help me word feedback for a colleague so it is direct but kind.',
  'Write a short description of the new export feature for the help center.',
  'Turn this list of changes into release notes people will read.',
];
const QUICK_EXAMPLES = [
  'What is the difference between p95 and p99 latency?',
  'How many working days are there in November?',
  'What does SLA stand for?',
  'Is it affect or effect in this sentence?',
  'What time is 15:00 CET in Helsinki?',
  'Quick one: what is a good name for a feature flag for the new export?',
  'What is the keyboard shortcut to search in Slack?',
  'Remind me what an idempotent request is.',
  'How many bytes are in a mebibyte?',
  'What is the capital of Estonia?',
  'Which is bigger, a terabyte or a tebibyte?',
  'What does HTTP status 409 mean?',
];
const TRANSLATE_EXAMPLES = [
  'Translate this paragraph into German.',
  'Put our onboarding checklist into Swedish, keep the headings.',
  'Can you translate this customer email from Finnish so I understand what they want?',
  'Translate the text below to English and keep the formatting.',
  'I need this reply in Norwegian, friendly but professional.',
  'Give me the Danish version of this job ad.',
  'Translate these release notes into Swedish.',
  'How do you say "the invoice is overdue" politely in French?',
  'Translate these product descriptions into Italian for the shop.',
  'Is this Polish sentence a complaint or a question? Translate it please.',
  'Translate the meeting invitation into Danish and Norwegian.',
  'What does this Japanese error message on the label mean?',
];
const DATA_EXAMPLES = [
  'Which customers churned last quarter and why?',
  'How do I calculate retention by signup cohort?',
  'Write a SQL query for weekly active users by plan.',
  'What is a good way to chart revenue by month and region?',
  'Is this difference in conversion rate statistically significant?',
  'Group these survey answers by theme and count them.',
  'Which features do our biggest accounts use the most?',
  'How do I find the median order value per month in SQL?',
  'Build a funnel from signup to first invoice sent.',
  'Why did average revenue per account drop in August?',
  'Compare trial conversion this quarter with last quarter.',
  'Which support topics grew the most this month?',
];

async function routing(admin: Session, ws: Workspace): Promise<Record<string, string>> {
  await admin.call('PUT', `/api/workspaces/${ws.id}/routing/settings`, {
    routingEnabled: true,
    defaultModel: SONNET,
    pinnedModel: null,
  });
  const routes: Record<string, string> = {};
  const add = async (body: Record<string, unknown>) => {
    const { route } = await admin.call<{ route: { id: string } }>(
      'POST',
      `/api/workspaces/${ws.id}/routes`,
      body,
    );
    routes[String(body['name'])] = route.id;
  };
  await add({
    name: 'code',
    model: SONNET,
    fallbacks: [HAIKU],
    description:
      'Writing, reviewing, debugging or explaining code, scripts, SQL, shell commands and error messages.',
    signals: ['code_fence', 'code_file'],
    examples: CODE_EXAMPLES,
  });
  await add({
    name: 'writing',
    model: SONNET,
    fallbacks: [HAIKU],
    description: 'Drafting or rewriting emails, updates, announcements, notes and other text.',
    examples: WRITING_EXAMPLES,
  });
  await add({
    name: 'quick-questions',
    model: HAIKU,
    description: 'Short factual questions with a short answer.',
    examples: QUICK_EXAMPLES,
  });
  await add({
    name: 'translate',
    model: FLASH,
    fallbacks: [HAIKU],
    allowCrossProvider: true,
    description: 'Translating text from one language into another, keeping the meaning and tone.',
    examples: TRANSLATE_EXAMPLES,
  });
  await add({
    name: 'data-questions',
    model: GPT,
    description: 'Analysing data, metrics, cohorts and SQL for reports.',
    examples: DATA_EXAMPLES,
    enabled: false,
  });
  return routes;
}

async function cap(
  admin: Session,
  path: string,
  dollars: number,
  period: 'daily' | 'monthly' | 'none',
): Promise<void> {
  await admin.call('PUT', path, { limitMicroUsd: usd(dollars).toString(), period });
}

interface Key {
  id: string;
  principalId: string;
  secret: string;
}

async function createKey(owner: Session, ws: Workspace, name: string): Promise<Key> {
  const { key: view, secret } = await owner.call<{ key: { id: string }; secret: string }>(
    'POST',
    `/api/workspaces/${ws.id}/keys`,
    { name },
  );
  const principalId = psql(`select principal_id from api_keys where id = ${lit(view.id)}`).trim();
  return { id: view.id, principalId, secret };
}

// Live traffic ---------------------------------------------------------------------------------

type Turn = { role: 'user' | 'assistant'; content: string };

interface Reply {
  requestId: string;
  status: number;
  text: string;
}

async function complete(
  caller: Session,
  headers: Record<string, string>,
  model: string,
  messages: Turn[],
): Promise<Reply> {
  const res = await caller.raw(
    'POST',
    '/v1/chat/completions',
    { model, messages, stream: true },
    headers,
  );
  const body = await res.text();
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
    try {
      const chunk = JSON.parse(line.slice(5)) as { choices?: { delta?: { content?: string } }[] };
      text += chunk.choices?.[0]?.delta?.content ?? '';
    } catch {
      // A comment or keep-alive line.
    }
  }
  return { requestId: res.headers.get('x-lakka-request-id') ?? '', status: res.status, text };
}

/** One conversation in chat, as the web app sends it. */
async function converse(
  caller: Session,
  ws: Workspace,
  title: string,
  prompts: readonly string[],
): Promise<{ id: string; requests: string[] }> {
  const { conversation } = await caller.call<{ conversation: { id: string } }>(
    'POST',
    `/api/workspaces/${ws.id}/conversations`,
    { title },
  );
  const headers = { 'x-lakka-workspace': ws.id, 'x-lakka-conversation': conversation.id };
  const history: Turn[] = [];
  const requests: string[] = [];
  for (const prompt of prompts) {
    history.push({ role: 'user', content: prompt });
    let reply = await complete(caller, headers, 'auto', history);
    requests.push(reply.requestId);
    // Tool calls that ask first: Sara approves; anyone else declines.
    for (let round = 0; round < 3; round += 1) {
      const { conversation: view } = await caller.call<{
        conversation: { pendingApproval: { id: string } | null };
      }>('GET', `/api/workspaces/${ws.id}/conversations/${conversation.id}`);
      if (view.pendingApproval === null) break;
      await sleep(round === 0 ? 1500 : 0);
      const answer = caller === saraSession ? 'x-lakka-approve' : 'x-lakka-deny';
      reply = await complete(
        caller,
        { ...headers, [answer]: view.pendingApproval.id },
        'auto',
        history,
      );
    }
    if (reply.status >= 400) throw new Error(`chat in ${title}: ${reply.status}`);
    history.push({ role: 'assistant', content: reply.text });
  }
  return { id: conversation.id, requests };
}

let saraSession: Session | undefined;

const CODE_REVIEW = [
  'Can you review this search hook before I merge it?',
  '',
  '```ts',
  'export function useSearch(onSearch: (q: string) => void, delay = 300) {',
  "  const [query, setQuery] = useState('');",
  '  useEffect(() => {',
  '    // debounce so we do not hit the API on every keystroke',
  '    setTimeout(() => onSearch(query), delay);',
  '  }, [query]);',
  '  return [query, setQuery] as const;',
  '}',
  '```',
].join('\n');
export const VIDEO_PROMPT = [
  'Same debounce question for the filter box, is this one fine?',
  '',
  '```ts',
  'useEffect(() => {',
  '  setTimeout(() => onFilter(filter), 250);',
  '}, [filter]);',
  '```',
].join('\n');

// History --------------------------------------------------------------------------------------

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
function price(ref: string): Price {
  const model = catalogue.models.find((m: { id: string }) => m.id === ref);
  if (model === undefined) throw new Error(`${ref} is not in the catalogue`);
  const p = model.prices as Record<string, number | null>;
  const input = p['inputMicroUsdPerMtok'] ?? 0;
  return {
    input,
    output: p['outputMicroUsdPerMtok'] ?? 0,
    cacheRead: p['cacheReadMicroUsdPerMtok'] ?? input,
    cacheWrite: p['cacheWriteMicroUsdPerMtok'] ?? input,
  };
}

interface Stream {
  workspaceId: string;
  actingUser: string;
  principal: string;
  surface: 'chat' | 'api';
  target: bigint;
  from: Date;
  to: Date;
  routing: 'product' | 'off';
}

function monthStart(d: Date, offset = 0): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}

/** A working-hours moment between `from` and `to`, weekdays three times as likely. */
function moment(from: Date, to: Date): Date {
  for (;;) {
    const t = new Date(from.getTime() + random() * (to.getTime() - from.getTime()));
    const weekend = t.getUTCDay() === 0 || t.getUTCDay() === 6;
    if (weekend && random() < 0.7) continue;
    t.setUTCHours(
      Math.floor(between(6, 16)),
      Math.floor(between(0, 60)),
      Math.floor(between(0, 60)),
    );
    if (t >= from && t < to) return t;
  }
}

function historyRows(
  streams: Stream[],
  ctx: {
    providers: Record<string, string>;
    routes: Record<string, string>;
    downgradeAfter: Date;
    downgrades: { left: number };
  },
): string[] {
  const rows: string[] = [];
  for (const s of streams) {
    let spent = 0n;
    while (spent < s.target) {
      const at = moment(s.from, s.to);
      let rule: string;
      let model: string;
      let routeId: string | null = null;
      let confidence: number | null = null;
      let defaultReason: string | null = null;
      if (s.surface === 'api') {
        rule = 'explicit';
        model = pick([
          [SONNET, 6],
          [HAIKU, 3],
          [OPUS, 1],
        ]);
      } else if (s.routing === 'off') {
        rule = pick([
          ['default', 8],
          ['explicit', 2],
        ]);
        model =
          rule === 'default'
            ? SONNET
            : pick([
                [FLASH, 1],
                [OPUS, 1],
              ]);
        if (rule === 'default') defaultReason = 'routing_off';
      } else {
        const route = pick([
          ['code', 34],
          ['writing', 15],
          ['quick-questions', 12],
          ['translate', 6],
          ['default', 15],
          ['explicit', 8],
        ]);
        if (route === 'default') {
          rule = 'default';
          model = SONNET;
          defaultReason = pick([
            ['below_threshold', 6],
            ['too_short', 3],
            ['ambiguous', 1],
          ]);
        } else if (route === 'explicit') {
          rule = 'explicit';
          model = pick([
            [OPUS, 3],
            [GPT, 1],
          ]);
        } else {
          rule = pick([
            ['classified', 4],
            ['sticky', 6],
          ]);
          model =
            { code: SONNET, writing: SONNET, 'quick-questions': HAIKU, translate: FLASH }[route] ??
            SONNET;
          routeId = ctx.routes[route] ?? null;
          confidence = Number(between(0.52, 0.93).toFixed(3));
        }
      }
      let fallbackFrom: string | null = null;
      if (
        model === SONNET &&
        s.routing === 'product' &&
        s.surface === 'chat' &&
        at >= ctx.downgradeAfter &&
        ctx.downgrades.left > 0
      ) {
        ctx.downgrades.left -= 1;
        fallbackFrom = SONNET;
        model = HAIKU;
      }
      const provider = model.split(':')[0] ?? '';
      const p = price(model);
      const input = s.surface === 'api' ? logBetween(20000, 200000) : logBetween(4000, 150000);
      const cacheRead = provider === 'anthropic' ? Math.floor(input * between(0, 0.7)) : 0;
      const uncached = input - cacheRead;
      let output = logBetween(300, 4000);
      let cost = BigInt(
        Math.ceil((uncached * p.input + cacheRead * p.cacheRead + output * p.output) / 1_000_000),
      );
      if (spent + cost > s.target) {
        // The last request of the stream lands exactly on the target.
        cost = s.target - spent;
        output = Math.max(
          1,
          Math.floor(
            (Number(cost) * 1_000_000 - uncached * p.input - cacheRead * p.cacheRead) / p.output,
          ),
        );
      }
      if (cost <= 0n) break;
      spent += cost;
      const ms = at.getTime();
      const latency = Math.round(700 + output * between(8, 20));
      rows.push(
        `(${[
          lit(uuidv7(ms)),
          lit(at.toISOString()),
          lit(uuidv7(ms)),
          '1',
          lit(random() < 0.01 ? 'aborted' : 'completed'),
          lit(s.surface),
          lit(s.workspaceId),
          lit(s.principal),
          lit(s.actingUser),
          lit(ctx.providers[provider] ?? null),
          lit(model),
          lit(provider),
          String(input),
          String(uncached),
          String(cacheRead),
          '0',
          String(output),
          'false',
          String(p.input),
          String(p.output),
          String(p.cacheRead),
          String(p.cacheWrite),
          cost.toString(),
          String(latency),
          String(Math.round(between(350, 1400))),
          lit('stop'),
          lit(rule),
          lit(routeId),
          confidence === null ? 'null' : String(confidence),
          lit(defaultReason),
          lit(fallbackFrom),
        ].join(', ')})`,
      );
    }
  }
  return rows;
}

const USAGE_COLUMNS = [
  'id',
  'created_at',
  'request_id',
  'attempt',
  'outcome',
  'surface',
  'workspace_id',
  'principal_id',
  'acting_user_id',
  'provider_config_id',
  'model',
  'provider',
  'input_tokens',
  'uncached_input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'output_tokens',
  'usage_estimated',
  'input_micro_usd_per_mtok',
  'output_micro_usd_per_mtok',
  'cache_read_micro_usd_per_mtok',
  'cache_write_micro_usd_per_mtok',
  'cost_micro_usd',
  'latency_ms',
  'ttft_ms',
  'finish_reason',
  'resolution_rule',
  'route_id',
  'route_confidence',
  'default_reason',
  'budget_fallback_from',
].join(', ');

function partitions(now: Date): string {
  const sql: string[] = [];
  for (const table of ['usage', 'spans']) {
    const from = monthStart(now, -1).toISOString().slice(0, 10);
    const to = monthStart(now).toISOString().slice(0, 10);
    const name = `${table}_y${from.slice(0, 4)}m${from.slice(5, 7)}`;
    sql.push(
      `create table if not exists ${name} partition of ${table} for values from ('${from} 00:00:00+00') to ('${to} 00:00:00+00');`,
    );
  }
  return sql.join('\n');
}

/** What real traffic already spent, by workspace and principal, so history adds the rest. */
function spentSoFar(): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const rows = psql(
    `select workspace_id, principal_id, sum(cost_micro_usd) from usage group by 1, 2`,
  );
  for (const line of rows.split('\n').filter(Boolean)) {
    const [ws, principal, sum] = line.split('|');
    out.set(`${ws}|${principal}`, BigInt(sum ?? '0'));
  }
  return out;
}

/** Each cap's spend for its current period, from usage, as the budget engine keeps it. */
const BUDGET_SPEND_SQL = `
insert into budget_spend (budget_id, period_start, spent_micro_usd, updated_at)
select b.id, p.start, coalesce((
  select sum(u.cost_micro_usd) from usage u
  where u.created_at >= p.start
    and (b.workspace_id is null or u.workspace_id = b.workspace_id)
    and (b.scope <> 'member' or u.acting_user_id = b.principal_id)
    and (b.scope <> 'key' or u.principal_id = b.principal_id)
), 0), now()
from budgets b
cross join lateral (select case b.period
  when 'daily' then date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
  when 'monthly' then date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
  else timestamptz '1970-01-01 00:00:00+00' end as start) p
on conflict (budget_id, period_start) do update set spent_micro_usd = excluded.spent_micro_usd, updated_at = now();
`;

// Main -----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const now = new Date();
  say('first-run setup');
  const admin = await setup();
  say('people');
  createPeople();
  const maja = person('maja');

  await admin.call('POST', '/api/sso/providers', {
    providerId: 'nordlys',
    displayName: 'Nordlys SSO',
    issuer: 'http://login.nordlys.example',
    clientId: 'lakka',
    clientSecret: randomBytes(18).toString('base64url'),
    allowSignUp: true,
    allowedEmailDomains: ['nordlys.example'],
  });

  say('providers');
  const providerIds = await providers(admin);

  say('workspaces');
  const support = await createWorkspace(admin, 'Support', 'support', 'per');
  const design = await createWorkspace(admin, 'Design', 'design', 'maja');
  await members(
    admin,
    products,
    PRODUCT_MEMBERS.filter((k) => k !== 'jonas'),
  );
  await members(admin, products, ['jonas'], 'admin');
  await members(admin, support, SUPPORT_MEMBERS);
  await members(admin, support, ['maja'], 'admin');
  await members(admin, design, DESIGN_MEMBERS);

  say('routing');
  const routes = await routing(admin, products);
  for (const ws of [support, design]) {
    await admin.call('PUT', `/api/workspaces/${ws.id}/routing/settings`, {
      routingEnabled: false,
      defaultModel: SONNET,
      pinnedModel: null,
    });
  }

  say('caps');
  await cap(admin, '/api/budgets/instance', 5000, 'monthly');
  await cap(admin, `/api/workspaces/${products.id}/budgets/workspace`, 1000, 'monthly');
  await cap(admin, `/api/workspaces/${support.id}/budgets/workspace`, 600, 'monthly');
  await cap(admin, `/api/workspaces/${design.id}/budgets/workspace`, 300, 'monthly');
  const memberCap = (key: string, dollars: number, period: 'daily' | 'monthly') =>
    cap(admin, `/api/workspaces/${products.id}/budgets/members/${person(key).id}`, dollars, period);
  await memberCap('maja', 200, 'monthly');
  await memberCap('erik', 200, 'monthly');
  await memberCap('sara', 150, 'monthly');
  await memberCap('lina', 100, 'monthly');
  await memberCap('nils', 10, 'daily');

  say('tools');
  await admin.call('POST', '/api/admin/mcp-origins', { origin: HELPDESK_ORIGIN });
  const { server } = await admin.call<{ server: { id: string } }>(
    'POST',
    `/api/workspaces/${support.id}/mcp-servers`,
    {
      transport: 'streamable_http',
      name: 'helpdesk',
      displayName: 'Helpdesk',
      url: `${HELPDESK_ORIGIN}/mcp`,
      authMode: 'none',
    },
  );
  const { tools } = await admin.call<{ tools: { id: string }[] }>(
    'POST',
    `/api/workspaces/${support.id}/mcp-servers/${server.id}/tools/sync`,
  );
  for (const tool of tools) {
    await admin.call('PATCH', `/api/workspaces/${support.id}/tools/${tool.id}`, { enabled: true });
  }

  say('keys');
  const erikSession = await signIn(person('erik').email, person('erik').secret ?? '');
  saraSession = await signIn(person('sara').email, person('sara').secret ?? '');
  const ciBot = await createKey(admin, products, 'CI bot');
  const notebook = await createKey(saraSession, products, 'Notebook');
  const macros = await createKey(erikSession, support, 'Support macros');
  await cap(admin, `/api/workspaces/${products.id}/budgets/keys/${ciBot.id}`, 100, 'monthly');
  await cap(admin, `/api/workspaces/${support.id}/budgets/keys/${macros.id}`, 25, 'none');

  say('chat and API traffic');
  const conversations: Record<string, string> = {};
  const older: { id: string; daysAgo: number }[] = [];
  const remember = (name: string, c: { id: string }, daysAgo = 0) => {
    conversations[name] = c.id;
    if (daysAgo > 0) older.push({ id: c.id, daysAgo });
  };
  remember(
    'cohorts',
    await converse(admin, products, 'Retention by signup cohort', [
      'How should I look at churn and retention for our September signups?',
    ]),
    9,
  );
  remember(
    'slowQuery',
    await converse(admin, products, 'Slow invoice query', [
      'Why is this query slow?\n\n```sql\nselect * from invoices where lower(customer_email) = $1 order by created_at desc;\n```',
    ]),
    4,
  );
  remember(
    'standup',
    await converse(admin, products, 'Standup notes', [
      'Draft my standup notes: finished CSV export, fixed date filter, today load testing and review with Jonas.',
    ]),
    1,
  );
  remember(
    'latency',
    await converse(admin, products, 'p95 or p99', [
      'What is the difference between p95 and p99 latency?',
    ]),
    1,
  );
  const lina = await signIn(person('lina').email, person('lina').secret ?? '');
  remember(
    'translate',
    await converse(lina, products, 'October release note in Swedish', [
      "Translate this into Swedish: What's new in October. You can now export invoices as CSV straight from the customer page. The export follows the filters you have chosen, and large exports are emailed to you when they are ready.",
    ]),
  );
  await converse(erikSession, products, 'p95 or p99', [
    'What is the difference between p95 and p99 latency?',
  ]);
  remember(
    'tickets',
    await converse(saraSession, support, 'Invoice export tickets', [
      'Find the open tickets about the invoice export and close any duplicates.',
    ]),
  );
  remember(
    'ticketsDenied',
    await converse(erikSession, support, 'Tidy invoice export tickets', [
      'Look through the invoice export tickets and close the duplicates.',
    ]),
  );
  for (const [caller, k, prompt] of [
    [
      ciBot,
      products,
      'Summarize the failing test output from the last CI run in three bullet points.',
    ],
    [ciBot, products, 'Write a changelog entry for the CSV export feature.'],
    [notebook, products, 'Group these survey answers by theme and count them.'],
  ] as const) {
    const reply = await complete(
      new Session(),
      { authorization: `Bearer ${caller.secret}`, 'x-lakka-workspace': k.id },
      SONNET,
      [{ role: 'user', content: prompt }],
    );
    if (reply.status >= 400) throw new Error(`API request: ${reply.status}`);
  }

  say('spend history');
  const before = spentSoFar();
  const curStart = monthStart(now);
  const prevStart = monthStart(now, -1);
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const streams: Stream[] = [];
  const add = (
    ws: Workspace,
    who: string,
    principal: string,
    surface: 'chat' | 'api',
    dollars: number,
    from: Date,
    to: Date,
    routingMode: 'product' | 'off',
  ) => {
    const already = from >= curStart ? (before.get(`${ws.id}|${principal}`) ?? 0n) : 0n;
    before.delete(`${ws.id}|${principal}`);
    const target = usd(dollars) - already;
    if (target > 0n) {
      streams.push({
        workspaceId: ws.id,
        actingUser: who,
        principal,
        surface,
        target,
        from,
        to,
        routing: routingMode,
      });
    }
  };
  for (const [ws, story, routingMode] of [
    [products, SPEND.product, 'product'],
    [support, SPEND.support, 'off'],
    [design, SPEND.design, 'off'],
  ] as const) {
    for (const [k, dollars] of Object.entries(story.cur)) {
      const id = person(k).id;
      if (k === 'nils') {
        add(ws, id, id, 'chat', dollars - NILS_TODAY, curStart, todayStart, routingMode);
        streams.push({
          workspaceId: ws.id,
          actingUser: id,
          principal: id,
          surface: 'chat',
          target: usd(NILS_TODAY),
          from: todayStart,
          to: now,
          routing: routingMode,
        });
      } else {
        add(ws, id, id, 'chat', dollars, curStart, now, routingMode);
      }
    }
    for (const [k, dollars] of Object.entries(story.prev)) {
      const id = person(k).id;
      add(ws, id, id, 'chat', dollars, prevStart, curStart, routingMode);
    }
  }
  add(products, maja.id, ciBot.principalId, 'api', KEY_SPEND.ciBot.cur, curStart, now, 'product');
  add(
    products,
    maja.id,
    ciBot.principalId,
    'api',
    KEY_SPEND.ciBot.prev,
    prevStart,
    curStart,
    'product',
  );
  add(
    products,
    person('sara').id,
    notebook.principalId,
    'api',
    KEY_SPEND.notebook.cur,
    curStart,
    now,
    'product',
  );
  add(
    products,
    person('sara').id,
    notebook.principalId,
    'api',
    KEY_SPEND.notebook.prev,
    prevStart,
    curStart,
    'product',
  );
  add(
    support,
    person('erik').id,
    macros.principalId,
    'api',
    KEY_SPEND.macros.cur,
    curStart,
    now,
    'off',
  );

  // The workspace ran low two days ago, so 41 of its last requests moved to a cheaper model.
  const downgradeAfter = new Date(now.getTime() - 2 * 86_400_000);
  const rows = historyRows(streams, {
    providers: providerIds,
    routes,
    downgradeAfter,
    downgrades: { left: 41 },
  });
  const sql = [partitions(now)];
  for (let i = 0; i < rows.length; i += 500) {
    sql.push(`insert into usage (${USAGE_COLUMNS}) values\n${rows.slice(i, i + 500).join(',\n')};`);
  }
  sql.push(BUDGET_SPEND_SQL);

  // Who signs in how, when they were last seen, and conversations from earlier days.
  for (const p of PEOPLE) {
    if (p.password !== true) {
      sql.push(
        `insert into auth_accounts (id, account_id, provider_id, user_id) select ${lit(randomBytes(12).toString('hex'))}, ${lit(randomBytes(10).toString('hex'))}, 'nordlys', auth_subject from principals where id = ${lit(p.id ?? '')};`,
      );
      if (p.key !== 'maja') {
        sql.push(
          `delete from auth_accounts where provider_id = 'credential' and user_id = (select auth_subject from principals where id = ${lit(p.id ?? '')});`,
        );
      }
    }
    const seen = new Date(now.getTime() - logBetween(1_800, 11 * 86_400) * 1000);
    sql.push(
      `update principals set last_active_at = ${lit(seen.toISOString())} where id = ${lit(p.id ?? '')};`,
    );
  }
  sql.push(`update principals set last_active_at = null where id = ${lit(person('tomas').id)};`);
  // Nordlys has used Lakka since spring: memberships are spread over the months before.
  sql.push(
    `update memberships set created_at = now() - (interval '1 day' * (20 + floor(random() * 160))) where principal_id <> ${lit(maja.id)};`,
    `update memberships set created_at = now() - interval '200 days' where principal_id = ${lit(maja.id)};`,
  );
  for (const { id, daysAgo } of older) {
    const shift = `interval '${daysAgo} days'`;
    sql.push(
      `update conversations set created_at = created_at - ${shift}, updated_at = updated_at - ${shift} where id = ${lit(id)};`,
    );
    sql.push(
      `update messages set created_at = created_at - ${shift} where conversation_id = ${lit(id)};`,
    );
  }
  psql(sql.join('\n'));
  say(`  ${rows.length} usage rows`);

  await admin.call('POST', `/api/users/${person('anna').id}/suspend`);

  // The worker rebuilds Valkey's counters from Postgres when it starts (invariant 5).
  say('rebuilding budget counters');
  docker(['restart', 'worker']);
  await sleep(8000);

  say('requests at the cap');
  const review = await converse(admin, products, 'Search hook review', [CODE_REVIEW]);
  remember('review', review);
  const refused = await complete(
    new Session(),
    { authorization: `Bearer ${macros.secret}`, 'x-lakka-workspace': support.id },
    HAIKU,
    [{ role: 'user', content: 'Draft a reply to the customer asking about the invoice export.' }],
  );
  if (refused.status !== 402)
    throw new Error(`expected the used-up key to be refused, got ${refused.status}`);

  writeFileSync(
    STATE_FILE,
    `${JSON.stringify(
      {
        admin: { email: maja.email, password: maja.secret },
        member: { email: person('sara').email, password: person('sara').secret },
        workspaces: { product: products.id, support: support.id, design: design.id },
        conversations,
        movedRequest: review.requests[0],
        refusedRequest: refused.requestId,
      },
      null,
      2,
    )}\n`,
  );
  say(`done; sign-ins for the capture are in ${STATE_FILE}`);
}

await main();
