import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { request } from '@playwright/test';
import { awaitSignInSlot } from './fixtures.ts';
import { createUser } from '../stack.ts';
import {
  configureKeycloak,
  E2E_INTROSPECTION_SECRET,
  E2E_KEYCLOAK_ADMIN_PORT,
  E2E_KEYCLOAK_URL,
} from '../integration/keycloak.ts';
import type { FullConfig } from '@playwright/test';

/*
 * Creates the accounts the suite uses, through the operator command in the running stack
 * (ADR 0033), and signs each in once, saving its browser session. Tests reuse those sessions:
 * sign-in throttling allows 3 attempts per address per 10 seconds, and the suite must not
 * weaken it, so each attempt takes a throttle slot first (fixtures.ts). First-run setup is tested on its own (first-run.spec.ts); it can happen only once
 * per stack, so the rest of the suite does not depend on the admin it creates.
 */

export const AUTH_DIR = 'test/e2e/.auth';

async function saveSession(
  baseURL: string,
  email: string,
  password: string,
  path: string,
): Promise<void> {
  const context = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  await awaitSignInSlot();
  const res = await context.post('/api/auth/sign-in/email', { data: { email, password } });
  if (!res.ok()) throw new Error(`sign-in for ${email} failed: ${res.status()}`);
  await context.storageState({ path });
  await context.dispose();
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:8080';
  const tag = randomBytes(3).toString('hex');
  const accounts = {
    admin: {
      email: `e2e-admin-${tag}@example.com`,
      name: 'E2E Admin',
      password: `e2e admin password ${tag}`,
    },
    member: {
      email: `e2e-member-${tag}@example.com`,
      name: 'E2E Member',
      password: `e2e member password ${tag}`,
    },
  };
  const adminId = createUser(
    accounts.admin.email,
    accounts.admin.name,
    accounts.admin.password,
    true,
  );
  const memberId = createUser(
    accounts.member.email,
    accounts.member.name,
    accounts.member.password,
    false,
  );

  mkdirSync(AUTH_DIR, { recursive: true });
  await saveSession(
    baseURL,
    accounts.admin.email,
    accounts.admin.password,
    `${AUTH_DIR}/admin.json`,
  );
  await saveSession(
    baseURL,
    accounts.member.email,
    accounts.member.password,
    `${AUTH_DIR}/member.json`,
  );

  // The people of the stack's Keycloak, for per-user credentials (TL-2, ADR 0074).
  const keycloak = {
    admin: {
      username: 'alice',
      password: `alice keycloak ${tag}`,
      firstName: 'Alice',
      lastName: 'A',
    },
    member: { username: 'bob', password: `bob keycloak ${tag}`, firstName: 'Bob', lastName: 'B' },
  };
  await configureKeycloak({
    adminUrl: `http://127.0.0.1:${E2E_KEYCLOAK_ADMIN_PORT}`,
    issuerUrl: E2E_KEYCLOAK_URL,
    people: [keycloak.admin, keycloak.member],
    trustedHosts: ['localhost', '127.0.0.1', new URL(baseURL).hostname],
    introspectionSecret: E2E_INTROSPECTION_SECRET,
  });

  // Workers inherit environment variables set here.
  process.env['LAKKA_E2E_ACCOUNTS'] = JSON.stringify({
    tag,
    admin: { ...accounts.admin, id: adminId },
    member: { ...accounts.member, id: memberId },
    keycloak,
  });
}
