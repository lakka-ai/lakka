import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { authAccounts } from '../schema/auth.ts';
import { ssoProviderPolicies, ssoProviders } from '../schema/sso.ts';

/*
 * Identity provider settings (ADR 0032). Listings never select oidc_config, so the client
 * secret is decrypted only when Better Auth needs it for a sign-in, when an admin replaces it,
 * and once for a provider added before its client id was kept beside it (ADR 0097).
 */

export interface SsoProviderRow {
  providerId: string;
  displayName: string;
  issuer: string;
  clientId: string | null;
  allowSignUp: boolean;
  allowedEmailDomains: string[];
  createdAt: Date;
  /** People who have signed in with it. */
  peopleCount: number;
  /** Of those, the ones with no other way to sign in. */
  onlyWayCount: number;
}

export interface SsoPolicy {
  allowSignUp: boolean;
  allowedEmailDomains: string[];
}

const columns = {
  providerId: ssoProviders.providerId,
  displayName: ssoProviderPolicies.displayName,
  issuer: ssoProviders.issuer,
  clientId: ssoProviderPolicies.clientId,
  allowSignUp: ssoProviderPolicies.allowSignUp,
  allowedEmailDomains: ssoProviderPolicies.allowedEmailDomains,
  createdAt: ssoProviderPolicies.createdAt,
  peopleCount: sql<number>`(
    select count(distinct a.user_id)::int from ${authAccounts} a
    where a.provider_id = ${ssoProviders.providerId}
  )`,
  onlyWayCount: sql<number>`(
    select count(distinct a.user_id)::int from ${authAccounts} a
    where a.provider_id = ${ssoProviders.providerId}
      and not exists (
        select 1 from ${authAccounts} o
        where o.user_id = a.user_id and o.provider_id <> a.provider_id
      )
  )`,
};

export async function listSsoProviders(db: Db): Promise<SsoProviderRow[]> {
  return db
    .select(columns)
    .from(ssoProviders)
    .innerJoin(ssoProviderPolicies, eq(ssoProviderPolicies.providerId, ssoProviders.providerId))
    .orderBy(asc(ssoProviderPolicies.displayName));
}

export async function insertSsoPolicy(
  db: Db,
  providerId: string,
  policy: SsoPolicy & { displayName: string; clientId: string },
): Promise<void> {
  await db.insert(ssoProviderPolicies).values({ providerId, ...policy });
}

export interface SsoPolicyUpdate extends SsoPolicy {
  displayName: string;
}

/**
 * Updates our half of a provider and, when a secret is given, replaces the client secret inside
 * Better Auth's stored settings, keeping the rest of them as they are (ADR 0097). Both or
 * neither.
 */
export async function updateSsoProviderSettings(
  db: Db,
  providerId: string,
  policy: SsoPolicyUpdate,
  clientSecret: string | undefined,
): Promise<'updated' | 'not_found'> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(ssoProviderPolicies)
      .set(policy)
      .where(eq(ssoProviderPolicies.providerId, providerId))
      .returning({ providerId: ssoProviderPolicies.providerId });
    if (updated.length === 0) return 'not_found';
    if (clientSecret === undefined) return 'updated';
    const [row] = await tx
      .select({ oidcConfig: ssoProviders.oidcConfig })
      .from(ssoProviders)
      .where(eq(ssoProviders.providerId, providerId))
      .for('update');
    const stored = row?.oidcConfig ?? null;
    const config: unknown = stored === null ? null : JSON.parse(stored);
    if (config === null || typeof config !== 'object') {
      throw new Error('the provider has no OIDC settings');
    }
    await tx
      .update(ssoProviders)
      .set({ oidcConfig: JSON.stringify({ ...config, clientSecret }) })
      .where(eq(ssoProviders.providerId, providerId));
    return 'updated';
  });
}

/** Keeps a copy of the provider's client id beside its policy (ADR 0097). */
export async function setSsoClientId(db: Db, providerId: string, clientId: string): Promise<void> {
  await db
    .update(ssoProviderPolicies)
    .set({ clientId })
    .where(eq(ssoProviderPolicies.providerId, providerId));
}

/**
 * The provider's OIDC settings as Better Auth stored them, decrypted, or undefined if there is
 * no such provider. It holds the client secret: never return or log it.
 */
export async function readSsoOidcConfig(db: Db, providerId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ oidcConfig: ssoProviders.oidcConfig })
    .from(ssoProviders)
    .where(eq(ssoProviders.providerId, providerId))
    .limit(1);
  return row?.oidcConfig ?? undefined;
}

export async function findSsoPolicy(db: Db, providerId: string): Promise<SsoPolicy | undefined> {
  const [row] = await db
    .select({
      allowSignUp: ssoProviderPolicies.allowSignUp,
      allowedEmailDomains: ssoProviderPolicies.allowedEmailDomains,
    })
    .from(ssoProviderPolicies)
    .where(eq(ssoProviderPolicies.providerId, providerId))
    .limit(1);
  return row;
}

/** Deletes a provider and, by cascade, its policy. Returns false if there was none. */
export async function deleteSsoProvider(db: Db, providerId: string): Promise<boolean> {
  const deleted = await db
    .delete(ssoProviders)
    .where(eq(ssoProviders.providerId, providerId))
    .returning({ providerId: ssoProviders.providerId });
  return deleted.length > 0;
}
