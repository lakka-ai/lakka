import { createMiddleware, createStart } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { contentSecurityPolicy, DOCUMENT_HEADERS, newNonce } from './lib/security.ts';

/*
 * Every request the app renders gets its own script nonce and the policy that names it
 * (ADR 0075 H6, ADR 0085). The router reads the nonce from the request context and puts it on
 * every script it writes. The dev server injects scripts of its own without a nonce, so the
 * policy is sent from production builds only; the e2e suite runs one and fails on any
 * violation.
 */

const securityHeaders = createMiddleware().server(({ next }) => {
  const nonce = newNonce();
  if (import.meta.env.PROD) {
    setResponseHeader('content-security-policy', contentSecurityPolicy(nonce));
  }
  for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) setResponseHeader(name, value);
  return next({ context: { cspNonce: nonce } });
});

export const startInstance = createStart(() => ({ requestMiddleware: [securityHeaders] }));
