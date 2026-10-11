import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { plainTools } from './mcp-plain-tools.ts';
import type { JsonRpcRequest } from './mcp-plain-tools.ts';

/*
 * An MCP server with no dependencies, for the acceptance stack (docker/compose.e2e.yaml), whose
 * fake-provider container runs plain Node without the repository's packages. It speaks just
 * enough of Streamable HTTP for Lakka's client: JSON-RPC over POST, answered with
 * application/json, which the transport allows, and no sessions. It offers echo and delete, as the
 * fixture built with the official server package does (mcp-plain-tools.ts). The integration
 * suite checks this server against Lakka's client, so the two stay in step.
 */

export interface PlainMcpServer {
  url: string;
  /** The name of every tool that actually ran, in order. */
  toolCalls: string[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** A real authorization server this server trusts, for per-user tokens (TL-2, ADR 0074). */
export interface PlainProtection {
  issuer: string;
  userFor(token: string | undefined): Promise<string | undefined>;
}

export async function startPlainMcpServer(
  listen: { host?: string; port?: number; publicHost?: string } = {},
  protection?: PlainProtection,
): Promise<PlainMcpServer> {
  const toolCalls: string[] = [];
  const sockets = new Set<Socket>();
  const { respond } = plainTools({
    whoami: protection !== undefined,
    onCall: (name) => toolCalls.push(name),
  });
  let url = '';

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://plain').pathname;
    if (protection !== undefined && path.startsWith('/.well-known/oauth-protected-resource')) {
      // RFC 9728: the resource, and the authorization server that issues tokens for it.
      send(res, 200, { resource: url, authorization_servers: [protection.issuer] });
      return;
    }
    let user: string | undefined;
    if (protection !== undefined) {
      user = await protection.userFor(req.headers.authorization?.replace(/^Bearer /, ''));
      if (user === undefined) {
        const metadata = `${new URL(url).origin}/.well-known/oauth-protected-resource/mcp`;
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${metadata}"` }).end();
        return;
      }
    }
    if (req.method !== 'POST') {
      // No server-initiated stream and no sessions to end.
      send(res, 405);
      return;
    }
    const message = (await readBody(req)) as JsonRpcRequest;
    if (message.id === undefined) {
      // A notification: accepted, nothing to say.
      send(res, 202);
      return;
    }
    send(res, 200, await respond(message, user));
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 400));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const host = listen.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(listen.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;
  url = `http://${listen.publicHost ?? host}:${port}/mcp`;
  return {
    url,
    toolCalls,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
