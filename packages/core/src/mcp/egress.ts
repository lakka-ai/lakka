import {
  ForbiddenError,
  InvalidRequestError,
  McpOriginNotAllowedError,
  NotFoundError,
} from '@lakka/contracts';
import type { McpAllowedOriginsView, Principal } from '@lakka/contracts';
import {
  countMcpAllowedOrigins,
  deleteMcpAllowedOrigin,
  insertMcpAllowedOrigin,
  listMcpAllowedOriginRows,
  listMcpAllowedOrigins,
} from '@lakka/db';
import type { McpServerRow } from '@lakka/db';
import { decideEgress, MAX_ALLOWED_ORIGINS, normaliseOrigin } from '../net/egress-policy.ts';
import type { EgressRule } from '../net/egress-policy.ts';
import type { McpTarget } from './client.ts';
import type { McpContext } from './servers.ts';

/*
 * The instance's allowlist of MCP origins (NF-S4, ADR 0117), and what it means for each
 * connection. The list is read from Postgres whenever a connection is made, never cached, so an
 * origin an instance admin removes is refused from the next connection on; if it cannot be read,
 * nothing connects. The origins in LAKKA_MCP_PRIVATE_ORIGINS count as listed.
 *
 * It is checked when a server is saved, so an admin hears at once that its origin needs listing,
 * and again on every connection: testing, syncing, connecting an account, and every tool call,
 * in this process or a tool runner.
 */

const instanceAdminsOnly = () =>
  new ForbiddenError('only instance admins change which tool server origins are allowed');

function requireInstanceAdmin(principal: Principal): void {
  if (principal.kind !== 'user' || !principal.isInstanceAdmin) throw instanceAdminsOnly();
}

/** Everything a server's traffic may reach: every listed origin. */
export async function mcpEgressRule(
  ctx: McpContext,
  server: Pick<McpServerRow, 'allowPrivate'>,
): Promise<EgressRule> {
  return {
    allowedOrigins: await listMcpAllowedOrigins(ctx.db),
    privateOrigins: ctx.mcpPrivateOrigins,
    allowPrivate: server.allowPrivate,
  };
}

/** Refuses a URL whose origin is not listed, when a server is saved. */
export async function requireAllowedOrigin(ctx: McpContext, url: string): Promise<void> {
  const decision = decideEgress(url, await mcpEgressRule(ctx, { allowPrivate: true }));
  if (!decision.allowed && decision.reason === 'not_listed') {
    throw new McpOriginNotAllowedError(decision.origin);
  }
}

/**
 * How to connect to `server` now. An HTTP server whose origin is not listed is refused here, with
 * the origin to list. Its connection may reach only that origin: redirects are not followed, so
 * nothing else is ever asked for. A stdio server gets the whole list, for whatever runs it to
 * keep to.
 */
export async function mcpTargetFor(ctx: McpContext, server: McpServerRow): Promise<McpTarget> {
  const rule = await mcpEgressRule(ctx, server);
  const target = {
    transport: server.transport,
    url: server.url,
    command: server.command,
    args: server.args,
    credentialEnv: server.credentialEnv,
    allowPrivate: server.allowPrivate,
    privateOrigins: [...rule.privateOrigins],
  };
  if (server.transport === 'stdio') return { ...target, allowedOrigins: [...rule.allowedOrigins] };
  // The schema guarantees an HTTP server has a URL.
  const decision = decideEgress(server.url as string, rule);
  if (!decision.allowed && decision.reason === 'not_listed') {
    throw new McpOriginNotAllowedError(decision.origin);
  }
  // A private address is refused when the connection is made, and reported as unreachable.
  return { ...target, allowedOrigins: decision.origin === null ? [] : [decision.origin] };
}

export async function listMcpOriginAllowlist(
  ctx: McpContext,
  principal: Principal,
): Promise<McpAllowedOriginsView> {
  requireInstanceAdmin(principal);
  const rows = await listMcpAllowedOriginRows(ctx.db);
  return {
    origins: rows.map((row) => ({
      origin: row.origin,
      source: row.source,
      addedBy: row.addedByName,
      createdAt: row.createdAt.toISOString(),
    })),
    configured: [...ctx.mcpPrivateOrigins],
  };
}

/** Lists an origin. True when it was added, false when it was listed already. */
export async function allowMcpOrigin(
  ctx: McpContext,
  principal: Principal,
  input: string,
): Promise<boolean> {
  requireInstanceAdmin(principal);
  const origin = normaliseOrigin(input);
  if (origin === null) {
    throw Object.assign(new InvalidRequestError('An origin is an http or https address.'), {
      param: 'origin',
    });
  }
  if ((await countMcpAllowedOrigins(ctx.db)) >= MAX_ALLOWED_ORIGINS) {
    throw new InvalidRequestError(`At most ${MAX_ALLOWED_ORIGINS} origins can be listed.`);
  }
  return insertMcpAllowedOrigin(ctx.db, origin, principal.actingUserId);
}

/** Takes an origin off the list: the next connection to it is refused. */
export async function disallowMcpOrigin(
  ctx: McpContext,
  principal: Principal,
  input: string,
): Promise<void> {
  requireInstanceAdmin(principal);
  const origin = normaliseOrigin(input);
  if (origin === null || !(await deleteMcpAllowedOrigin(ctx.db, origin))) {
    throw new NotFoundError('that origin is not listed');
  }
}
