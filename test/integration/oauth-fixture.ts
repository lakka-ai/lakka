import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * A small OAuth 2.1 authorization server for MCP tests (TL-2, ADR 0068): metadata discovery,
 * dynamic client registration (optional), the authorization code flow with PKCE (S256 only) and
 * resource indicators, and refresh tokens that rotate. There is no login page: whoever follows
 * the authorization URL with `test_user=<name>` added has authorized as <name>. Not a real
 * server; the real one is Keycloak (ADR 0074).
 */

export interface OAuthFixture {
  issuer: string;
  /** The user an access token was issued to; undefined for an unknown or expired one. */
  userFor(token: string | undefined): string | undefined;
  /** How many refresh grants and dynamic registrations it has served. */
  counts: { refreshes: number; registrations: number };
  /** The `resource` each token request named. */
  resources: string[];
  /** Every access and refresh token issued, to check none leaks. */
  issued: string[];
  /** Forgets every refresh token, as revoking the grant at the server would. */
  forgetRefreshTokens(): void;
  /** Registers a client as an admin would, out of band, for servers without registration. */
  addClient(clientId: string, secret: string, redirectUri: string): void;
  close(): Promise<void>;
}

interface Client {
  secret: string | undefined;
  redirectUris: string[];
}

const b64url = (buffer: Buffer) => buffer.toString('base64url');

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startOAuthFixture(
  options: { registration?: boolean; accessTtlSeconds?: number } = {},
): Promise<OAuthFixture> {
  const registration = options.registration ?? true;
  const ttl = options.accessTtlSeconds ?? 3600;
  const clients = new Map<string, Client>();
  const codes = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      challenge: string;
      user: string;
      resource: string | null;
    }
  >();
  const access = new Map<string, { user: string; expires: number }>();
  const refresh = new Map<string, { user: string; clientId: string }>();
  const counts = { refreshes: 0, registrations: 0 };
  const resources: string[] = [];
  const issued: string[] = [];
  let issuer = '';

  function authenticateClient(req: IncomingMessage, form: URLSearchParams): string | undefined {
    const header = req.headers.authorization;
    let id: string | null = form.get('client_id');
    let secret: string | null = form.get('client_secret');
    if (header?.startsWith('Basic ') === true) {
      const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      id = decodeURIComponent(user ?? '');
      secret = decodeURIComponent(pass ?? '');
    }
    const client = id === null ? undefined : clients.get(id);
    if (client === undefined || id === null) return undefined;
    if (client.secret !== undefined && client.secret !== secret) return undefined;
    return id;
  }

  function issue(user: string, clientId: string) {
    const accessToken = b64url(randomBytes(24));
    const refreshToken = b64url(randomBytes(24));
    access.set(accessToken, { user, expires: Date.now() + ttl * 1000 });
    refresh.set(refreshToken, { user, clientId });
    issued.push(accessToken, refreshToken);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ttl,
      refresh_token: refreshToken,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(registration ? { registration_endpoint: `${issuer}/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: [
          'client_secret_basic',
          'client_secret_post',
          'none',
        ],
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/register' && registration) {
      const body = JSON.parse(await readBody(req)) as {
        redirect_uris?: string[];
        token_endpoint_auth_method?: string;
      };
      const clientId = b64url(randomBytes(12));
      const secret =
        body.token_endpoint_auth_method === 'none' ? undefined : b64url(randomBytes(24));
      clients.set(clientId, { secret, redirectUris: body.redirect_uris ?? [] });
      counts.registrations += 1;
      json(res, 201, {
        ...body,
        client_id: clientId,
        ...(secret === undefined ? {} : { client_secret: secret }),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const q = url.searchParams;
      const client = clients.get(q.get('client_id') ?? '');
      const redirectUri = q.get('redirect_uri') ?? '';
      if (client === undefined || !client.redirectUris.includes(redirectUri)) {
        json(res, 400, { error: 'invalid_request' });
        return;
      }
      if (q.get('code_challenge_method') !== 'S256' || q.get('code_challenge') === null) {
        json(res, 400, {
          error: 'invalid_request',
          error_description: 'PKCE with S256 is required',
        });
        return;
      }
      const code = b64url(randomBytes(16));
      codes.set(code, {
        clientId: q.get('client_id') ?? '',
        redirectUri,
        challenge: q.get('code_challenge') ?? '',
        user: q.get('test_user') ?? 'anonymous',
        resource: q.get('resource'),
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      const clientId = authenticateClient(req, form);
      if (clientId === undefined) {
        json(res, 401, { error: 'invalid_client' });
        return;
      }
      resources.push(form.get('resource') ?? '');
      if (form.get('grant_type') === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = b64url(createHash('sha256').update(verifier).digest());
        if (
          code === undefined ||
          code.clientId !== clientId ||
          code.redirectUri !== form.get('redirect_uri') ||
          code.challenge !== challenge ||
          (code.resource !== null && code.resource !== form.get('resource'))
        ) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        json(res, 200, issue(code.user, clientId));
        return;
      }
      if (form.get('grant_type') === 'refresh_token') {
        const token = form.get('refresh_token') ?? '';
        const grant = refresh.get(token);
        // Rotation: a refresh token works once.
        refresh.delete(token);
        if (grant === undefined || grant.clientId !== clientId) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        counts.refreshes += 1;
        json(res, 200, issue(grant.user, clientId));
        return;
      }
      json(res, 400, { error: 'unsupported_grant_type' });
      return;
    }
    json(res, 404, { error: 'not_found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    userFor(token) {
      const grant = token === undefined ? undefined : access.get(token);
      return grant !== undefined && grant.expires > Date.now() ? grant.user : undefined;
    },
    counts,
    resources,
    issued,
    forgetRefreshTokens: () => refresh.clear(),
    addClient(clientId, secret, redirectUri) {
      clients.set(clientId, { secret, redirectUris: [redirectUri] });
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
