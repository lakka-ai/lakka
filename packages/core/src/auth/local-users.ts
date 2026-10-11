import { APIError } from 'better-auth/api';
import { EmailTakenError } from '@lakka/contracts';
import type { Principal } from '@lakka/contracts';
import { deleteAuthSessionByToken } from '@lakka/db';
import type { Db, NewAuthUser } from '@lakka/db';
import type { Auth } from './auth.ts';
import { ensureUserPrincipal, toPrincipal } from './principals.ts';

export interface LocalUserInput {
  email: string;
  password: string;
  name: string;
}

export interface CreatedAuthAccount {
  user: NewAuthUser;
  /**
   * Set-Cookie values that sign the new person in, when asked for; otherwise empty. A surface
   * that talks to a browser passes them on, so someone who just chose a password does not have
   * to type it again.
   */
  sessionCookies: string[];
}

/**
 * Creates the Better Auth side of a local account (ID-2) and nothing else. First-run setup and
 * invite acceptance create the principal themselves, in the same transaction as the access it
 * comes with. Public sign-up is not exposed over HTTP; only server code calls this.
 */
export async function createAuthAccount(
  ctx: { auth: Auth; db: Db },
  input: LocalUserInput,
  options: { signIn: boolean },
): Promise<CreatedAuthAccount> {
  let result;
  try {
    result = await ctx.auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
      returnHeaders: true,
    });
  } catch (error) {
    // With autoSignIn on, Better Auth reports an existing email instead of pretending success.
    if (error instanceof APIError && error.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
      throw new EmailTakenError('an account with this email already exists', { cause: error });
    }
    throw error;
  }
  const { user, token } = result.response;
  const created = { id: user.id, email: user.email, name: user.name };
  if (options.signIn) return { user: created, sessionCookies: result.headers.getSetCookie() };
  // Better Auth signs the new user in, but this caller has nowhere to send that session.
  // Delete it rather than leave an unused bearer credential in the database.
  if (token !== null) await deleteAuthSessionByToken(ctx.db, token);
  return { user: created, sessionCookies: [] };
}

/**
 * Creates a local account with its principal, and no workspace access. Used by the operator
 * command; the principal is created after Better Auth has committed the user (ADR 0028).
 */
export async function createLocalUser(
  ctx: { auth: Auth; db: Db },
  input: LocalUserInput,
): Promise<Principal> {
  const { user } = await createAuthAccount(ctx, input, { signIn: false });
  return toPrincipal(await ensureUserPrincipal(ctx.db, user));
}
