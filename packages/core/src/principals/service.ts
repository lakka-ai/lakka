import {
  ForbiddenError,
  InvalidRequestError,
  LastInstanceAdminError,
  NotFoundError,
  SelfDeletionError,
  SelfSuspensionError,
} from '@lakka/contracts';
import type {
  DeletePersonBody,
  InstanceAdminBody,
  MeView,
  Principal,
  SignInMethodView,
  UserAdminView,
} from '@lakka/contracts';
import {
  changeInstanceAdmin,
  deleteAuthSessionsForUser,
  erasePerson,
  findLivePerson,
  findPrincipalEmail,
  listSignInsForPeople,
  listUserPrincipals,
  listWorkspacesForPeople,
  setUserStatus,
} from '@lakka/db';
import type { Db, PrincipalRow } from '@lakka/db';
import type { ServiceContext } from '../context.ts';

/*
 * Instance administration of people (ID-6, ADR 0031). Suspension takes effect on the person's
 * next request, because every request re-reads their status, and it also deletes their sessions,
 * so reactivating them later does not revive an old login. Their keys stop working while they
 * are suspended and work again on reactivation; revoke keys separately to kill them for good.
 */

export function requireInstanceAdmin(principal: Principal): void {
  if (!(principal.isInstanceAdmin && principal.kind === 'user')) {
    throw new ForbiddenError('only instance admins manage people');
  }
}

/** Better Auth's provider id for an email and password account. */
const PASSWORD_PROVIDER = 'credential';

function signInOrder(a: SignInMethodView, b: SignInMethodView): number {
  if (a.kind !== b.kind) return a.kind === 'password' ? -1 : 1;
  if (a.kind === 'password' || b.kind === 'password') return 0;
  return (a.displayName ?? a.providerId).localeCompare(b.displayName ?? b.providerId);
}

/** The People page's rows (ID-6, ADR 0097): each person with their workspaces and sign-ins. */
async function views(db: Db, rows: PrincipalRow[]): Promise<UserAdminView[]> {
  const [memberships, signIns] = await Promise.all([
    listWorkspacesForPeople(
      db,
      rows.map((row) => row.id),
    ),
    listSignInsForPeople(
      db,
      rows.flatMap((row) => (row.authSubject === null ? [] : [row.authSubject])),
    ),
  ]);
  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    status: row.status,
    isInstanceAdmin: row.isInstanceAdmin,
    createdAt: row.createdAt.toISOString(),
    workspaces: memberships
      .filter((m) => m.principalId === row.id)
      .map((m) => ({ id: m.workspaceId, name: m.name, role: m.role })),
    signsInWith: signIns
      .filter((s) => s.authSubject === row.authSubject)
      .map((s): SignInMethodView =>
        s.providerId === PASSWORD_PROVIDER
          ? { kind: 'password' }
          : { kind: 'sso', providerId: s.providerId, displayName: s.displayName },
      )
      .toSorted(signInOrder),
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
  }));
}

async function view(db: Db, row: PrincipalRow): Promise<UserAdminView> {
  const [one] = await views(db, [row]);
  if (one === undefined) throw new Error('views returned no view');
  return one;
}

/**
 * What /api/me answers (ID-1): the principal, and for a person's own session their email, for
 * the account menu. A key's caller gets null: the key acts for its owner, but whoever holds it
 * has no need of the owner's address.
 */
export async function describeMe(ctx: ServiceContext, principal: Principal): Promise<MeView> {
  if (principal.kind !== 'user') return { principal, email: null };
  return { principal, email: (await findPrincipalEmail(ctx.db, principal.id)) ?? null };
}

export async function listUsers(
  ctx: ServiceContext,
  principal: Principal,
): Promise<UserAdminView[]> {
  requireInstanceAdmin(principal);
  return views(ctx.db, await listUserPrincipals(ctx.db));
}

/**
 * Grants or removes instance admin (ID-3, ADR 0097). The instance always keeps one active
 * instance admin, so nobody can remove the last way in. The change applies on the person's next
 * request, since every request re-reads it.
 */
export async function setUserInstanceAdmin(
  ctx: ServiceContext,
  principal: Principal,
  targetPrincipalId: string,
  body: InstanceAdminBody,
): Promise<UserAdminView> {
  requireInstanceAdmin(principal);
  const change = await changeInstanceAdmin(ctx.db, targetPrincipalId, body.isInstanceAdmin);
  if (change.outcome === 'not_found') throw new NotFoundError('no user with this id');
  if (change.outcome === 'last_admin') {
    throw new LastInstanceAdminError('the instance must keep an active instance admin');
  }
  return view(ctx.db, change.row);
}

export async function suspendUser(
  ctx: ServiceContext,
  principal: Principal,
  targetPrincipalId: string,
): Promise<UserAdminView> {
  requireInstanceAdmin(principal);
  if (targetPrincipalId === principal.actingUserId) {
    throw new SelfSuspensionError('you cannot suspend yourself');
  }
  const row = await setUserStatus(ctx.db, targetPrincipalId, 'suspended');
  if (row === undefined) throw new NotFoundError('no user with this id');
  if (row.authSubject !== null) await deleteAuthSessionsForUser(ctx.db, row.authSubject);
  await ctx.events.principalRevoked({
    principalId: row.id,
    reason: 'suspended',
    workspaceId: null,
  });
  return view(ctx.db, row);
}

export async function reactivateUser(
  ctx: ServiceContext,
  principal: Principal,
  targetPrincipalId: string,
): Promise<UserAdminView> {
  requireInstanceAdmin(principal);
  const row = await setUserStatus(ctx.db, targetPrincipalId, 'active');
  if (row === undefined) throw new NotFoundError('no user with this id');
  return view(ctx.db, row);
}

/**
 * Deletes a person (NF-P4, ADR 0082): their sign-in, memberships and everything they said, with
 * their keys revoked. What records their spend stays, pointing at a nameless tombstone, so caps
 * and reports stay true. Their open requests end at once. The caller confirms by the person's
 * email, and cannot delete themselves; a workspace they alone administer refuses it.
 */
export async function deleteUser(
  ctx: ServiceContext,
  principal: Principal,
  targetPrincipalId: string,
  body: DeletePersonBody,
): Promise<{ keyPrincipalIds: string[] }> {
  requireInstanceAdmin(principal);
  if (targetPrincipalId === principal.actingUserId) {
    throw new SelfDeletionError('you cannot delete yourself');
  }
  const person = await findLivePerson(ctx.db, targetPrincipalId);
  if (person === undefined) throw new NotFoundError('no user with this id');
  if (person.email?.toLowerCase() !== body.confirmEmail.trim().toLowerCase()) {
    throw new InvalidRequestError("confirmEmail: does not match the person's email");
  }
  const erased = await erasePerson(ctx.db, person.id, principal.actingUserId);
  if (erased === undefined) throw new NotFoundError('no user with this id');
  for (const principalId of [person.id, ...erased.keyPrincipalIds]) {
    await ctx.events.principalRevoked({ principalId, reason: 'deleted', workspaceId: null });
  }
  return erased;
}
