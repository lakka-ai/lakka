import type { FastifyRequest } from 'fastify';
import { RateLimitedError } from '@lakka/contracts';
import type { RateLimitStorage } from '@lakka/core';

/*
 * Per-address throttling for public endpoints that do expensive work (hashing a password) or
 * take a secret as input (a setup code, an invite token). Counts live in Valkey, as for sign-in,
 * and a Valkey failure refuses the request.
 */

/**
 * The client address. Caddy replaces any X-Forwarded-For the client sent with the address it
 * saw, so the first entry cannot be spoofed through the proxy (ADR 0033). Without it, the
 * request came from inside the compose network.
 */
export function clientAddress(request: FastifyRequest): string {
  const header = request.headers['x-forwarded-for'];
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
  return first !== undefined && first !== '' ? first : request.ip;
}

export interface ThrottleRule {
  /** Counter name, so separate endpoints do not share a budget. */
  name: string;
  windowSeconds: number;
  max: number;
}

/** preHandler that refuses with 429 once an address has used up its attempts in the window. */
export function throttle(storage: RateLimitStorage, rule: ThrottleRule) {
  return async (request: FastifyRequest): Promise<void> => {
    const result = await storage.consume(`${rule.name}:${clientAddress(request)}`, {
      window: rule.windowSeconds,
      max: rule.max,
    });
    if (!result.allowed) {
      throw new RateLimitedError(
        'too many attempts; try again later',
        result.retryAfter ?? rule.windowSeconds,
      );
    }
  };
}
