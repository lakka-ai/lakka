import { createHash, timingSafeEqual } from 'node:crypto';
import { InvalidSetupCodeError, SetupCompleteError } from '@lakka/contracts';
import type { CompleteSetupInput, SetupResult, SetupSecrets, SetupStatus } from '@lakka/contracts';
import { completeSetup, deleteAuthUser, isSetupComplete } from '@lakka/db';
import type { Db } from '@lakka/db';
import type { Auth } from '../auth/auth.ts';
import { createAuthAccount } from '../auth/local-users.ts';

/*
 * First-run setup (AD-1, ADR 0034). Until it is done, whoever holds the setup code may see the
 * credential master key (ADR 0021) and create the first instance admin and workspace. The code
 * is a generated secret that only someone with access to the server can read, so a stranger who
 * reaches a fresh instance first cannot claim it.
 */

export interface SetupContext {
  auth: Auth;
  db: Db;
  /** From the secrets volume or LAKKA_SETUP_CODE. Without one, setup cannot be completed. */
  setupCode: string | undefined;
  credentialMasterKey: string;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Compares digests so the time taken says nothing about how much of the code was right. */
export function setupCodeMatches(expected: string | undefined, given: string): boolean {
  if (expected === undefined) return false;
  return timingSafeEqual(digest(expected.trim()), digest(given.trim()));
}

async function authorizeSetup(ctx: SetupContext, code: string): Promise<void> {
  if (await isSetupComplete(ctx.db))
    throw new SetupCompleteError('setup has already been completed');
  if (!setupCodeMatches(ctx.setupCode, code))
    throw new InvalidSetupCodeError('the setup code is not right');
}

export async function getSetupStatus(ctx: Pick<SetupContext, 'db'>): Promise<SetupStatus> {
  return { required: !(await isSetupComplete(ctx.db)) };
}

/**
 * Returns the credential master key so the operator can save it before finishing setup. After
 * setup the api never returns it again (ADR 0021); the operator reads it on the server with
 * `lakka recovery-key` (ADR 0115).
 */
export async function revealSetupSecrets(ctx: SetupContext, code: string): Promise<SetupSecrets> {
  await authorizeSetup(ctx, code);
  return { credentialMasterKey: ctx.credentialMasterKey };
}

/**
 * Creates the first instance admin (a local account) and the first workspace, with that person
 * as its admin, and returns cookies that sign them in. If anything fails after the account was
 * created, the account and its session are removed again, so a failed attempt can be retried
 * with the same email address.
 */
export async function completeFirstRunSetup(
  ctx: SetupContext,
  input: CompleteSetupInput,
): Promise<SetupResult & { principalId: string; sessionCookies: string[] }> {
  await authorizeSetup(ctx, input.code);
  const { user: admin, sessionCookies } = await createAuthAccount(ctx, input.admin, {
    signIn: true,
  });
  try {
    const { principal, workspace } = await completeSetup(ctx.db, {
      admin,
      workspace: input.workspace,
    });
    return {
      principalId: principal.id,
      sessionCookies,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        role: 'admin',
        createdAt: workspace.createdAt.toISOString(),
      },
    };
  } catch (error) {
    await deleteAuthUser(ctx.db, admin.id);
    throw error;
  }
}
