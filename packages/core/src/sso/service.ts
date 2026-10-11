import { z } from 'zod';
import { ForbiddenError, InvalidRequestError, NotFoundError } from '@lakka/contracts';
import type {
  Principal,
  PublicSsoProvider,
  SsoProviderView,
  UpdateSsoProviderBody,
} from '@lakka/contracts';
import {
  deleteSsoProvider,
  insertSsoPolicy,
  listSsoProviders,
  readSsoOidcConfig,
  setSsoClientId,
  updateSsoProviderSettings,
} from '@lakka/db';
import type { Db, SsoProviderRow } from '@lakka/db';
import { AUTH_BASE_PATH } from '../auth/auth.ts';
import type { AuthContext } from '../auth/authenticate.ts';

/*
 * Managing OIDC identity providers (ID-2, AD-1: configured in the browser, not in files). Only
 * instance admins, and only signed in with a session: Better Auth's registration checks the
 * caller's own session, and a key must not be able to add a way to sign in (ADR 0032).
 */

export interface RegisterSsoProviderInput {
  providerId: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowSignUp: boolean;
  allowedEmailDomains: string[];
}

function requireInstanceAdminUser(principal: Principal): void {
  if (!(principal.kind === 'user' && principal.isInstanceAdmin)) {
    throw new ForbiddenError('only instance admins manage identity providers');
  }
}

/** The OIDC callback Better Auth serves for a provider; the api exposes exactly this path. */
export function ssoRedirectUri(publicUrl: string, providerId: string): string {
  return `${publicUrl}${AUTH_BASE_PATH}/sso/callback/${providerId}`;
}

function view(row: SsoProviderRow, publicUrl: string): SsoProviderView {
  return {
    providerId: row.providerId,
    displayName: row.displayName,
    issuer: row.issuer,
    clientId: row.clientId,
    redirectUri: ssoRedirectUri(publicUrl, row.providerId),
    allowSignUp: row.allowSignUp,
    allowedEmailDomains: row.allowedEmailDomains,
    createdAt: row.createdAt.toISOString(),
    peopleCount: row.peopleCount,
    onlyWayCount: row.onlyWayCount,
  };
}

/** The one part of Better Auth's stored OIDC settings we read. */
const storedOidcConfig = z.looseObject({ clientId: z.string() });

async function storedConfig(db: Db, providerId: string) {
  const raw = await readSsoOidcConfig(db, providerId);
  if (raw === undefined) return undefined;
  const parsed = storedOidcConfig.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : undefined;
}

/**
 * Providers added before their client id was kept beside the policy get it filled in from
 * Better Auth's settings, once (ADR 0097).
 */
async function withClientIds(db: Db, rows: SsoProviderRow[]): Promise<SsoProviderRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.clientId !== null) return row;
      const config = await storedConfig(db, row.providerId);
      if (config === undefined) return row;
      await setSsoClientId(db, row.providerId, config.clientId);
      return { ...row, clientId: config.clientId };
    }),
  );
}

/** A safe, machine-readable reason from a Better Auth error, never its free-text message. */
function reasonOf(error: unknown): string {
  const body: unknown =
    error !== null && typeof error === 'object' && 'body' in error ? error.body : undefined;
  const code: unknown =
    body !== null && typeof body === 'object' && 'code' in body ? body.code : undefined;
  return typeof code === 'string' && /^[A-Za-z_]{1,64}$/.test(code)
    ? code.toLowerCase()
    : 'rejected';
}

export async function registerSsoProvider(
  ctx: AuthContext,
  principal: Principal,
  sessionHeaders: Headers,
  input: RegisterSsoProviderInput,
  publicUrl: string,
): Promise<SsoProviderView> {
  requireInstanceAdminUser(principal);
  try {
    await ctx.auth.api.registerSSOProvider({
      headers: sessionHeaders,
      body: {
        providerId: input.providerId,
        issuer: input.issuer,
        // The plugin requires a domain. It is only used for email-based provider lookup and
        // domain-verified linking, neither of which is enabled.
        domain:
          input.allowedEmailDomains.length > 0
            ? input.allowedEmailDomains.join(',')
            : new URL(input.issuer).hostname,
        oidcConfig: { clientId: input.clientId, clientSecret: input.clientSecret },
      },
    });
  } catch (error) {
    throw new InvalidRequestError(
      `the identity provider could not be registered: ${reasonOf(error)}`,
      {
        cause: error,
      },
    );
  }
  try {
    await insertSsoPolicy(ctx.db, input.providerId, {
      displayName: input.displayName,
      clientId: input.clientId,
      allowSignUp: input.allowSignUp,
      allowedEmailDomains: input.allowedEmailDomains,
    });
  } catch (error) {
    await deleteSsoProvider(ctx.db, input.providerId);
    throw error;
  }
  const row = (await listSsoProviders(ctx.db)).find((p) => p.providerId === input.providerId);
  if (row === undefined) throw new Error('registered provider not found');
  return view(row, publicUrl);
}

export async function listSsoProvidersForAdmin(
  ctx: AuthContext,
  principal: Principal,
  publicUrl: string,
): Promise<SsoProviderView[]> {
  requireInstanceAdminUser(principal);
  return (await withClientIds(ctx.db, await listSsoProviders(ctx.db))).map((row) =>
    view(row, publicUrl),
  );
}

/**
 * Edits a provider's name, who it may create accounts for, and its client secret (ADR 0097).
 * The secret is written into Better Auth's stored settings directly, because its own update
 * route lets only the admin who registered a provider change it. The secret is not one of the
 * settings that decide who a sign-in is, so changing it needs none of the checks that route
 * adds for those.
 */
export async function updateSsoProvider(
  ctx: AuthContext,
  principal: Principal,
  providerId: string,
  body: UpdateSsoProviderBody,
  publicUrl: string,
): Promise<SsoProviderView> {
  requireInstanceAdminUser(principal);
  const outcome = await updateSsoProviderSettings(
    ctx.db,
    providerId,
    {
      displayName: body.displayName,
      allowSignUp: body.allowSignUp,
      allowedEmailDomains: body.allowedEmailDomains,
    },
    body.clientSecret,
  );
  if (outcome === 'not_found') throw new NotFoundError('no such identity provider');
  const row = (await listSsoProviders(ctx.db)).find((p) => p.providerId === providerId);
  if (row === undefined) throw new NotFoundError('no such identity provider');
  const [filled = row] = await withClientIds(ctx.db, [row]);
  return view(filled, publicUrl);
}

export async function listPublicSsoProviders(ctx: AuthContext): Promise<PublicSsoProvider[]> {
  return (await listSsoProviders(ctx.db)).map((p) => ({
    providerId: p.providerId,
    displayName: p.displayName,
  }));
}

export async function removeSsoProvider(
  ctx: AuthContext,
  principal: Principal,
  providerId: string,
): Promise<void> {
  requireInstanceAdminUser(principal);
  if (!(await deleteSsoProvider(ctx.db, providerId)))
    throw new NotFoundError('no such identity provider');
}
