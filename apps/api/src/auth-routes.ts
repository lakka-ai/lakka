import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { UnauthenticatedError } from '@lakka/contracts';
import type { ApiErrorBody, Principal } from '@lakka/contracts';
import { AUTH_BASE_PATH, authenticate, describeMe } from '@lakka/core';
import type { AuthContext, Credential } from '@lakka/core';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requirePrincipal on routes that need a signed-in principal. */
    principal: Principal | null;
  }
}

/*
 * The api's adapter for Better Auth (ADR 0028). Only the routes listed here are reachable over
 * HTTP; everything else under /api/auth is a 404, including public sign-up, which first-run
 * setup and invites replace (ADR 0034, ADR 0035). New Better Auth routes stay closed until someone
 * adds them here deliberately.
 */
export const EXPOSED_AUTH_ROUTES: ReadonlySet<string> = new Set([
  `POST ${AUTH_BASE_PATH}/sign-in/email`,
  `POST ${AUTH_BASE_PATH}/sign-in/sso`,
  `POST ${AUTH_BASE_PATH}/sign-out`,
  `GET ${AUTH_BASE_PATH}/get-session`,
]);

/** The OIDC callback carries the provider id in its path (ADR 0032). SAML routes stay closed. */
const SSO_CALLBACK = /^\/api\/auth\/sso\/callback\/[a-z0-9-]{1,40}$/;

export function isExposedAuthRoute(method: string, path: string): boolean {
  return (
    EXPOSED_AUTH_ROUTES.has(`${method} ${path}`) || (method === 'GET' && SSO_CALLBACK.test(path))
  );
}

export function toFetchHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
  }
  return out;
}

const notFound: ApiErrorBody = { error: { code: 'not_found', message: 'Not found' } };

export interface AuthRoutesOptions {
  context: AuthContext;
  publicUrl: string;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  app,
  { context, publicUrl },
) => {
  app.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASE_PATH}/*`,
    handler: async (request, reply) => {
      const url = new URL(request.url, publicUrl);
      if (!isExposedAuthRoute(request.method, url.pathname)) {
        return reply.status(404).send(notFound);
      }
      const response = await context.auth.handler(
        new Request(url, {
          method: request.method,
          headers: toFetchHeaders(request.headers),
          ...(request.body === undefined || request.body === null
            ? {}
            : { body: JSON.stringify(request.body) }),
        }),
      );
      void reply.status(response.status);
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') void reply.header(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) void reply.header('set-cookie', cookies);
      return reply.send(response.body === null ? null : await response.text());
    },
  });

  app.get('/api/me', {
    preHandler: requirePrincipal(context),
    handler: async (request) => describeMe(context, principalOf(request)),
  });
};

/**
 * Extracts the credential: a bearer API key if an Authorization header is present, otherwise the
 * session cookie. A request with a bad key is refused, never retried with its cookie.
 */
export function credentialOf(request: FastifyRequest): Credential {
  const authorization = request.headers.authorization;
  if (authorization === undefined)
    return { kind: 'session', headers: toFetchHeaders(request.headers) };
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (match?.[1] === undefined) throw new UnauthenticatedError('unsupported authorization header');
  return { kind: 'api_key', secret: match[1] };
}

/** The principal set by requirePrincipal, for handlers on routes that use it. */
export function principalOf(request: FastifyRequest): Principal {
  // requirePrincipal runs as the route's preHandler and throws if it cannot set this.
  if (request.principal === null) throw new Error('requirePrincipal did not run');
  return request.principal;
}

/** preHandler that resolves the credential to a Principal or fails with 401 (ID-1). */
export function requirePrincipal(context: AuthContext) {
  return async (request: FastifyRequest): Promise<void> => {
    request.principal = await authenticate(context, credentialOf(request));
  };
}
