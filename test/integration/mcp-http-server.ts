import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { fixtureServer } from './mcp-fixture-server.ts';
import type { FixtureVariant } from './mcp-fixture-server.ts';

/*
 * The fixture as a Streamable HTTP server on 127.0.0.1 (TL-1). With a token, requests without
 * `Authorization: Bearer <token>` get a 401, as a server behind a shared credential would. With
 * an OAuth fixture, it is a protected resource (TL-2): it advertises the authorization server in
 * its metadata, accepts only tokens that server issued, and its whoami tool names the user.
 */

export interface McpHttpFixture {
  url: string;
  /** The Authorization header of every request, in order. */
  authorizations: (string | undefined)[];
  /** With OAuth: the user of every authenticated request, in order. */
  users: string[];
  /** Changes the tools it offers from now on. */
  setVariant(variant: FixtureVariant): void;
  /** The name of every tool that actually ran, in order. */
  toolCalls: string[];
  close(): Promise<void>;
}

/**
 * The authorization server whose tokens the fixture accepts: our own (oauth-fixture.ts) or a
 * real one (keycloak.ts). `userFor` names the user a token was issued to, or undefined.
 */
export interface ProtectedBy {
  issuer: string;
  userFor(token: string | undefined): string | undefined | Promise<string | undefined>;
  /** What to advertise in scopes_supported; tools:read unless given, none when empty. */
  scopes?: readonly string[];
}

export async function startMcpHttpServer(
  options: { token?: string; oauth?: ProtectedBy } = {},
): Promise<McpHttpFixture> {
  const authorizations: (string | undefined)[] = [];
  const users: string[] = [];
  let url = '';
  let current: string | undefined;
  let variant: FixtureVariant = 'default';
  const toolCalls: string[] = [];
  const scopes = options.oauth?.scopes ?? ['tools:read'];
  const handler = createMcpHandler(() =>
    fixtureServer(
      () => (current === undefined ? 'no credential' : current),
      variant,
      (name) => toolCalls.push(name),
    ),
  );
  const server = createServer((req, res) => {
    void (async () => {
      const authorization = req.headers.authorization;
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (options.oauth !== undefined && path.startsWith('/.well-known/oauth-protected-resource')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            resource: url,
            authorization_servers: [options.oauth.issuer],
            ...(scopes.length === 0 ? {} : { scopes_supported: scopes }),
          }),
        );
        return;
      }
      authorizations.push(authorization);
      if (options.token !== undefined && authorization !== `Bearer ${options.token}`) {
        res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
        return;
      }
      if (options.oauth === undefined) {
        current = authorization === undefined ? undefined : 'bearer credential';
      } else {
        const user = await options.oauth.userFor(authorization?.replace(/^Bearer /, ''));
        if (user === undefined) {
          const metadata = `${new URL(url).origin}/.well-known/oauth-protected-resource/mcp`;
          res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${metadata}"` });
          res.end();
          return;
        }
        users.push(user);
        current = user;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      }
      const response = await handler.fetch(
        new Request(`http://127.0.0.1${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body !== null) for await (const chunk of response.body) res.write(chunk);
      res.end();
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}/mcp`;
  return {
    url,
    authorizations,
    users,
    toolCalls,
    setVariant: (next) => {
      variant = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handler.close?.();
    },
  };
}
