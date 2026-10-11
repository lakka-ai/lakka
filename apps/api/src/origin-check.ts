import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorBody } from '@lakka/contracts';

/*
 * Cross-site request protection (ADR 0006). For a state-changing request without an
 * Authorization header (which would carry no ambient credential):
 *   - an Origin header must be one of ours. Browsers send Origin on cross-site POSTs, so this
 *     also stops login CSRF (a foreign page signing the victim in as the attacker), which Better
 *     Auth alone does not stop for requests that carry no cookie yet.
 *   - with no Origin, a request that carries a cookie must be same-origin by Sec-Fetch-Site.
 *   - with neither Origin nor cookie it is a non-browser client with nothing to forge.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const forbidden: ApiErrorBody = {
  error: {
    code: 'origin_not_allowed',
    message: 'This request must come from the Lakka web app.',
  },
};

export function originAllowed(
  request: Pick<FastifyRequest, 'method' | 'headers'>,
  trustedOrigins: readonly string[],
): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  if (request.headers.authorization !== undefined) return true;
  const origin = request.headers.origin;
  if (origin !== undefined) return trustedOrigins.includes(origin);
  if (request.headers.cookie === undefined) return true;
  return request.headers['sec-fetch-site'] === 'same-origin';
}

export function originCheck(trustedOrigins: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!originAllowed(request, trustedOrigins)) await reply.status(403).send(forbidden);
  };
}
