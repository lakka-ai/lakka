import { describe, expect, it } from 'vitest';
import type { Principal, WorkspaceRole } from '@lakka/contracts';
import { decide, mayCreateWorkspace } from '../src/authz/policy.ts';
import type { WorkspaceAction } from '../src/authz/policy.ts';

const WS = 'ws-1';

const user = (overrides: Partial<Principal> = {}): Principal => ({
  id: 'u1',
  kind: 'user',
  displayName: 'Ada',
  actingUserId: 'u1',
  isInstanceAdmin: false,
  workspaceScope: null,
  ...overrides,
});

const key = (ownerId: string, scope: string = WS): Principal => ({
  id: 'k1',
  kind: 'key',
  displayName: 'CI key',
  actingUserId: ownerId,
  isInstanceAdmin: false,
  workspaceScope: scope,
});

const ALL: WorkspaceAction[] = [
  'workspace.read',
  'workspace.update',
  'members.read',
  'members.add',
  'members.change_role',
  'members.remove',
  'keys.issue',
  'keys.list',
  'keys.revoke',
  'invites.create',
  'invites.list',
  'invites.revoke',
  'providers.read',
  'providers.manage',
  'policy.read',
  'policy.manage',
  'models.use',
  'budgets.read',
  'budgets.manage',
  'tools.read',
  'tools.manage',
];

const run = (
  principal: Principal,
  action: WorkspaceAction,
  role: WorkspaceRole | null,
  target?: string,
) =>
  decide({
    principal,
    action,
    role,
    workspaceId: WS,
    ...(target === undefined ? {} : { targetPrincipalId: target }),
  });

const table = (principal: Principal, role: WorkspaceRole | null) =>
  Object.fromEntries(ALL.map((a) => [a, run(principal, a, role)]));

describe('workspace policy', () => {
  it('ID-3: instance admins may do everything, except issue a key or spend where they are not a member', () => {
    const admin = user({ isInstanceAdmin: true });
    for (const action of ALL) {
      expect(run(admin, action, null)).toBe(
        action === 'keys.issue' || action === 'models.use' ? 'deny' : 'allow',
      );
    }
    expect(run(admin, 'keys.issue', 'member')).toBe('allow');
    expect(run(admin, 'models.use', 'member')).toBe('allow');
  });

  it('AC 16: a non-member is told the workspace does not exist', () => {
    for (const action of ALL) expect(run(user(), action, null)).toBe('hidden');
  });

  it('ID-3, ID-7, PR-8, BG-1, TL-3: a workspace admin manages the workspace, its keys, invites, provider credentials, routing policy, member budgets and tools, but cannot add people directly', () => {
    expect(table(user(), 'admin')).toEqual({
      'workspace.read': 'allow',
      'workspace.update': 'allow',
      'members.read': 'allow',
      'members.add': 'deny',
      'members.change_role': 'allow',
      'members.remove': 'allow',
      'keys.issue': 'allow',
      'keys.list': 'allow',
      'keys.revoke': 'allow',
      'invites.create': 'allow',
      'invites.list': 'allow',
      'invites.revoke': 'allow',
      'providers.read': 'allow',
      'providers.manage': 'allow',
      'policy.read': 'allow',
      'policy.manage': 'allow',
      'models.use': 'allow',
      'budgets.read': 'allow',
      'budgets.manage': 'allow',
      'tools.read': 'allow',
      'tools.manage': 'allow',
    });
  });

  it('ID-3, ID-5, BG-1: a member reads, issues keys, sees their own budgets, and may leave or revoke only their own', () => {
    expect(table(user(), 'member')).toEqual({
      'workspace.read': 'allow',
      'workspace.update': 'deny',
      'members.read': 'allow',
      'members.add': 'deny',
      'members.change_role': 'deny',
      'members.remove': 'deny',
      'keys.issue': 'allow',
      'keys.list': 'allow',
      'keys.revoke': 'deny',
      'invites.create': 'deny',
      'invites.list': 'deny',
      'invites.revoke': 'deny',
      'providers.read': 'deny',
      'providers.manage': 'deny',
      'policy.read': 'deny',
      'policy.manage': 'deny',
      'models.use': 'allow',
      'budgets.read': 'allow',
      'budgets.manage': 'deny',
      'tools.read': 'deny',
      'tools.manage': 'deny',
    });
    expect(run(user(), 'members.remove', 'member', 'u1')).toBe('allow');
    expect(run(user(), 'keys.revoke', 'member', 'u1')).toBe('allow');
    expect(run(user(), 'keys.revoke', 'member', 'u2')).toBe('deny');
  });

  it('ID-5, NF-S2, ID-7, PR-3, BG-1: a key has exactly its owner role, and never manages keys, invites, provider credentials, routing policy or budgets', () => {
    const k = key('owner');
    expect(run(k, 'workspace.update', 'admin')).toBe('allow');
    expect(run(k, 'workspace.update', 'member')).toBe('deny');
    for (const action of [
      'keys.issue',
      'keys.list',
      'keys.revoke',
      'invites.create',
      'invites.list',
      'invites.revoke',
      'providers.read',
      'providers.manage',
      'policy.read',
      'policy.manage',
      'budgets.read',
      'budgets.manage',
    ] as const) {
      expect(run(k, action, 'admin')).toBe('deny');
    }
    // Using models is what a key is for.
    expect(run(k, 'models.use', 'member')).toBe('allow');
  });

  it('ID-5: a key acts only in its own workspace, even one its owner also belongs to', () => {
    const k = key('owner', 'another-workspace');
    for (const action of ALL) expect(run(k, action, 'admin')).toBe('hidden');
  });

  it('ID-5: a key stops working in a workspace its owner left', () => {
    for (const action of ALL) expect(run(key('owner'), action, null)).toBe('hidden');
  });

  it('NF-S2: a key cannot use an instance admin flag, even if one were set on it', () => {
    const k = { ...key('owner'), isInstanceAdmin: true };
    expect(run(k, 'members.add', 'member')).toBe('deny');
    expect(run(k, 'workspace.read', null)).toBe('hidden');
    expect(mayCreateWorkspace(k)).toBe(false);
  });

  it('ID-3: only instance admin users create workspaces', () => {
    expect(mayCreateWorkspace(user({ isInstanceAdmin: true }))).toBe(true);
    expect(mayCreateWorkspace(user())).toBe(false);
  });
});
