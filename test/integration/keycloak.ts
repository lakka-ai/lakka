/*
 * Keycloak as a real OAuth authorization server for MCP (TL-2, M6 exit, ADR 0074), set up through
 * its admin REST API: a realm with people in it, anonymous dynamic client registration for the
 * hosts Lakka redirects from, and an audience mapper, since Keycloak does not read the
 * `resource` parameter (RFC 8707) and tokens must still name the MCP server they are for.
 *
 * Plain Node only: the acceptance stack's fake-provider container imports this file too.
 */

export const KEYCLOAK_IMAGE = 'quay.io/keycloak/keycloak:26.7.4';
export const KEYCLOAK_ADMIN = { username: 'admin', password: 'keycloak-tests-only' };
export const KEYCLOAK_REALM = 'mcp';
/**
 * The MCP server's client in the realm, and the audience every access token carries. Keycloak
 * introspects a token as active only for a client in its audience, which is also the right
 * meaning: the token is for this server.
 */
export const MCP_AUDIENCE = 'mcp-fixture';

/*
 * The acceptance stack's Keycloak (docker/compose.e2e.yaml). The browser and the api reach it at
 * one HTTPS address: containers by its network alias, the browser through the published port,
 * since Chromium resolves any *.localhost name to loopback, so the port is the same inside and
 * out. The suite's admin calls and the MCP server's introspection use plain HTTP inside, which
 * carries no client credentials of Lakka's.
 */
export const E2E_KEYCLOAK_PORT = Number(process.env['LAKKA_E2E_KEYCLOAK_PORT'] ?? 18543);
export const E2E_KEYCLOAK_ADMIN_PORT = Number(
  process.env['LAKKA_E2E_KEYCLOAK_ADMIN_PORT'] ?? 18480,
);
export const E2E_KEYCLOAK_URL = `https://keycloak.localhost:${E2E_KEYCLOAK_PORT}`;
/** Where the MCP server in the stack introspects tokens. */
export const E2E_KEYCLOAK_INTERNAL_URL = 'http://keycloak:8080';
/** Known before the realm exists, since the MCP server starts first. Tests only. */
export const E2E_INTROSPECTION_SECRET = 'e2e-introspection-secret-tests-only';

export interface KeycloakPerson {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
}

export interface KeycloakSetup {
  /** The realm's issuer, as the MCP server advertises it. */
  issuer: string;
  /** The MCP server's own client, for introspecting the tokens it is given. */
  introspection: { clientId: string; clientSecret: string };
}

async function ok(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`Keycloak: ${what} failed with ${response.status}: ${await response.text()}`);
  }
  return response;
}

/**
 * Creates the realm. `adminUrl` is where this process reaches Keycloak; `issuerUrl` is the base
 * the MCP server and Lakka reach it at, when that differs (the acceptance stack).
 */
export async function configureKeycloak(options: {
  adminUrl: string;
  issuerUrl?: string;
  people: readonly KeycloakPerson[];
  /** Hosts Lakka's redirect URIs may use, for anonymous registration. */
  trustedHosts: readonly string[];
  accessTokenLifespanSeconds?: number;
  /** The MCP server's introspection secret, when it must be known before the realm exists. */
  introspectionSecret?: string;
}): Promise<KeycloakSetup> {
  const base = options.adminUrl.replace(/\/$/, '');
  const token = (
    (await (
      await ok(
        await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'password',
            client_id: 'admin-cli',
            ...KEYCLOAK_ADMIN,
          }),
        }),
        'admin sign-in',
      )
    ).json()) as { access_token: string }
  ).access_token;
  const admin = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}/admin/realms${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const realm = `/${KEYCLOAK_REALM}`;

  // A realm left from an earlier run on the same Keycloak is replaced, not reused.
  if ((await admin(realm)).ok)
    await ok(await admin(realm, { method: 'DELETE' }), 'replacing the realm');

  await ok(
    await admin('', {
      method: 'POST',
      body: {
        realm: KEYCLOAK_REALM,
        enabled: true,
        // Every address in the tests is plain HTTP on a private network.
        sslRequired: 'none',
        accessTokenLifespan: options.accessTokenLifespanSeconds ?? 300,
      },
    }),
    'creating the realm',
  );

  for (const person of options.people) {
    await ok(
      await admin(`${realm}/users`, {
        method: 'POST',
        body: {
          username: person.username,
          email: `${person.username}@example.com`,
          emailVerified: true,
          firstName: person.firstName,
          lastName: person.lastName,
          enabled: true,
          credentials: [{ type: 'password', value: person.password, temporary: false }],
        },
      }),
      `creating ${person.username}`,
    );
  }

  // Tokens name the MCP server in `aud`, from a scope every client gets by default.
  await ok(
    await admin(`${realm}/client-scopes`, {
      method: 'POST',
      body: {
        name: 'mcp-audience',
        protocol: 'openid-connect',
        attributes: { 'include.in.token.scope': 'false', 'display.on.consent.screen': 'false' },
        protocolMappers: [
          {
            name: 'mcp audience',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-audience-mapper',
            config: {
              'included.custom.audience': MCP_AUDIENCE,
              'access.token.claim': 'true',
              'introspection.token.claim': 'true',
              'id.token.claim': 'false',
            },
          },
        ],
      },
    }),
    'creating the audience scope',
  );
  const scopes = (await (await admin(`${realm}/client-scopes`)).json()) as {
    id: string;
    name: string;
  }[];
  const audienceScope = scopes.find((s) => s.name === 'mcp-audience');
  if (audienceScope === undefined) throw new Error('Keycloak: the audience scope is missing');
  await ok(
    await admin(`${realm}/default-default-client-scopes/${audienceScope.id}`, { method: 'PUT' }),
    'making the audience scope a default',
  );

  // Anonymous registration: only for redirect URIs on these hosts, from anywhere.
  const policies = (await (
    await admin(
      `${realm}/components?type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy`,
    )
  ).json()) as { id: string; providerId: string; subType: string; config: object }[];
  const trusted = policies.find(
    (p) => p.providerId === 'trusted-hosts' && p.subType === 'anonymous',
  );
  if (trusted === undefined) throw new Error('Keycloak: no trusted-hosts policy');
  await ok(
    await admin(`${realm}/components/${trusted.id}`, {
      method: 'PUT',
      body: {
        ...trusted,
        config: {
          'trusted-hosts': options.trustedHosts,
          'host-sending-registration-request-must-match': ['false'],
          'client-uris-must-match': ['true'],
        },
      },
    }),
    'trusting the redirect hosts',
  );

  // The MCP server's own confidential client, which may introspect tokens (RFC 7662).
  const clientSecret =
    options.introspectionSecret ?? `introspection-${Math.random().toString(36).slice(2)}`;
  await ok(
    await admin(`${realm}/clients`, {
      method: 'POST',
      body: {
        clientId: MCP_AUDIENCE,
        protocol: 'openid-connect',
        publicClient: false,
        secret: clientSecret,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
      },
    }),
    'creating the introspection client',
  );

  const issuerBase = (options.issuerUrl ?? base).replace(/\/$/, '');
  return {
    issuer: `${issuerBase}/realms/${KEYCLOAK_REALM}`,
    introspection: { clientId: MCP_AUDIENCE, clientSecret },
  };
}

/**
 * The MCP server's check of a bearer token: Keycloak says whether it is active and whose it is,
 * and it must be meant for this server. Returns the username, or undefined.
 */
export function keycloakVerifier(
  setup: KeycloakSetup,
  introspectionBase: string = setup.issuer,
): (token: string | undefined) => Promise<string | undefined> {
  return async (token) => {
    if (token === undefined || token === '') return undefined;
    const { clientId, clientSecret } = setup.introspection;
    const response = await fetch(`${introspectionBase}/protocol/openid-connect/token/introspect`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ token }),
    });
    if (!response.ok) return undefined;
    const claims = (await response.json()) as {
      active?: boolean;
      username?: string;
      aud?: string | string[];
    };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.active !== true || !audiences.includes(MCP_AUDIENCE)) return undefined;
    return claims.username;
  };
}

/** Cookies as a browser keeps them, well enough for one sign-in. */
class CookieJar {
  readonly #cookies = new Map<string, string>();

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const at = pair?.indexOf('=') ?? -1;
      if (pair !== undefined && at > 0) this.#cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }

  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const decode = (html: string) =>
  html.replaceAll('&amp;', '&').replaceAll('&#x3D;', '=').replaceAll('&quot;', '"');

/** The first form on a page: where it posts, and its hidden fields. */
function formOf(html: string): { action: string; fields: Record<string, string> } | undefined {
  const form = /<form\b[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (form === null) return undefined;
  const fields: Record<string, string> = {};
  for (const input of (form[2] ?? '').matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    if (!/type="hidden"/i.test(tag)) continue;
    const name = /name="([^"]*)"/i.exec(tag)?.[1];
    const value = /value="([^"]*)"/i.exec(tag)?.[1] ?? '';
    if (name !== undefined) fields[name] = decode(value);
  }
  return { action: decode(form[1] ?? ''), fields };
}

/**
 * Plays a person's browser at Keycloak: opens the authorization URL, signs in, and answers the
 * consent screen if one is shown. Returns where Keycloak sends the browser back to, the client's
 * redirect URI with a code (or an error).
 */
export async function signInAtKeycloak(
  authorizationUrl: string,
  person: { username: string; password: string },
  consent: 'accept' | 'deny' = 'accept',
): Promise<URL> {
  const jar = new CookieJar();
  const origin = new URL(authorizationUrl).origin;
  let response = await fetch(authorizationUrl, { redirect: 'manual' });
  for (let step = 0; step < 10; step += 1) {
    jar.store(response);
    const location = response.headers.get('location');
    if (location !== null) {
      const next = new URL(location, response.url === '' ? origin : response.url);
      if (next.origin !== origin) return next;
      response = await fetch(next, { redirect: 'manual', headers: { cookie: jar.header() } });
      continue;
    }
    const html = await response.text();
    const form = formOf(html);
    if (form === undefined) throw new Error(`Keycloak: no form on the page (${response.status})`);
    const signIn = /name="password"/.test(html);
    const body = new URLSearchParams({
      ...form.fields,
      ...(signIn
        ? { username: person.username, password: person.password, credentialId: '' }
        : consent === 'accept'
          ? { accept: 'Yes' }
          : { cancel: 'No' }),
    });
    response = await fetch(new URL(form.action, origin), {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  }
  throw new Error('Keycloak: the sign-in did not finish');
}
