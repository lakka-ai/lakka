import { createServer } from 'node:net';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

/*
 * Dex (Apache-2.0) as a real OIDC provider for integration tests (ADR 0032). Password logins
 * only, in memory, no approval screen. Every test user's password is "password".
 */

export const DEX_IMAGE = 'ghcr.io/dexidp/dex:v2.45.1-distroless';
export const DEX_CLIENT_ID = 'lakka-tests';
export const DEX_CLIENT_SECRET = 'dex-client-secret-for-tests-only';
export const DEX_PASSWORD = 'password';
// bcrypt of "password", from Dex's own example configuration.
const PASSWORD_HASH = '$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W';

export interface DexUser {
  email: string;
  username: string;
}

export interface Dex {
  issuer: string;
  origin: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Starts Dex with a fixed host port so its issuer URL is known before it starts. */
export async function startDex(options: {
  callbackUrls: string[];
  users: DexUser[];
}): Promise<Dex> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const issuer = `${origin}/dex`;
  const config = [
    `issuer: ${issuer}`,
    'storage:',
    '  type: memory',
    'web:',
    '  http: 0.0.0.0:5556',
    'oauth2:',
    '  skipApprovalScreen: true',
    'enablePasswordDB: true',
    'staticClients:',
    `  - id: ${DEX_CLIENT_ID}`,
    `    secret: ${DEX_CLIENT_SECRET}`,
    '    name: Lakka tests',
    '    redirectURIs:',
    ...options.callbackUrls.map((u) => `      - ${u}`),
    'staticPasswords:',
    ...options.users.flatMap((u, i) => [
      `  - email: ${u.email}`,
      `    hash: "${PASSWORD_HASH}"`,
      `    username: ${u.username}`,
      `    userID: "00000000-0000-4000-8000-${String(i).padStart(12, '0')}"`,
    ]),
  ].join('\n');

  const container: StartedTestContainer = await new GenericContainer(DEX_IMAGE)
    .withExposedPorts({ container: 5556, host: port })
    .withCopyContentToContainer([{ content: `${config}\n`, target: '/etc/dex/config.yaml' }])
    .withCommand(['dex', 'serve', '/etc/dex/config.yaml'])
    .withWaitStrategy(Wait.forHttp('/dex/.well-known/openid-configuration', 5556))
    .start();
  return { issuer, origin, stop: async () => void (await container.stop()) };
}

/**
 * Walks Dex's password login in place of a browser: follows its redirects, submits the login
 * form, and stops at the first redirect back to `appOrigin`, returning that URL.
 */
export async function loginAtDex(
  authorizationUrl: string,
  appOrigin: string,
  email: string,
  password = DEX_PASSWORD,
): Promise<URL> {
  let url = new URL(authorizationUrl);
  for (let hop = 0; hop < 10; hop += 1) {
    if (url.origin === appOrigin) return url;
    const res = await fetch(url, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (location !== null) {
      url = new URL(location, url);
      continue;
    }
    const html = await res.text();
    const action = /<form[^>]*action="([^"]+)"/i.exec(html)?.[1];
    if (res.status !== 200 || action === undefined) {
      throw new Error(`unexpected Dex response ${res.status} at ${url.pathname}`);
    }
    const post = await fetch(new URL(action.replaceAll('&amp;', '&'), url), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ login: email, password }),
    });
    const next = post.headers.get('location');
    if (next === null) throw new Error(`Dex login failed with status ${post.status}`);
    url = new URL(next, url);
  }
  throw new Error('too many redirects at Dex');
}
