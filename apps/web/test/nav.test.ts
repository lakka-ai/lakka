import { describe, expect, it } from 'vitest';
import { currentWorkspace, navItems, navModel } from '../src/components/shell/nav.ts';
import { layoutFromCookie } from '../src/lib/layout-memory.ts';
import { workspaceFromCookie } from '../src/lib/workspace-memory.ts';

const product = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' as const };
const support = { id: '22222222-2222-4222-8222-222222222222', role: 'member' as const };
const design = { id: '33333333-3333-4333-8333-333333333333', role: null };

const keys = (model: ReturnType<typeof navModel>) => navItems(model).map((i) => i.key);

describe('main menu', () => {
  it('a member gets chat and the workspace pages, without Routing, Tools or Admin', () => {
    expect(keys(navModel({ isInstanceAdmin: false }, support))).toEqual([
      'chat',
      'spend',
      'requests',
      'connections',
      'workspace',
    ]);
  });

  it('a workspace admin also gets Routing and Tools, in the drawn order', () => {
    expect(keys(navModel({ isInstanceAdmin: false }, product))).toEqual([
      'chat',
      'spend',
      'requests',
      'routing',
      'tools',
      'connections',
      'workspace',
    ]);
  });

  it('ID-6: an instance admin gets the Admin group, and manages workspaces they are not in', () => {
    const model = navModel({ isInstanceAdmin: true }, design);
    expect(model.workspace.map((i) => i.key)).toContain('routing');
    expect(model.admin.map((i) => i.key)).toEqual([
      'workspaces',
      'peopleAndSignIn',
      'modelsAndProviders',
      'toolServers',
      'instanceSpend',
      'retention',
      'diagnostics',
    ]);
  });

  it('without a workspace there is nothing to chat in, and admins keep the Admin group', () => {
    const model = navModel({ isInstanceAdmin: true }, null);
    expect(model.chat).toBeNull();
    expect(model.workspace).toEqual([]);
    expect(model.admin).toHaveLength(7);
    expect(keys(navModel({ isInstanceAdmin: false }, null))).toEqual([]);
  });

  it('links every workspace page to the workspace shown', () => {
    for (const item of navItems(navModel({ isInstanceAdmin: false }, product)))
      expect(item.link).toMatchObject({ params: { workspaceId: product.id } });
  });
});

describe('current workspace', () => {
  const all = [design, support, product];

  it('prefers the address, then the one used last, then the first one you belong to', () => {
    expect(currentWorkspace(all, product.id, support.id)).toBe(product);
    expect(currentWorkspace(all, undefined, product.id)).toBe(product);
    expect(currentWorkspace(all, undefined, undefined)).toBe(support);
    expect(currentWorkspace([design], undefined, undefined)).toBe(design);
    expect(currentWorkspace([], undefined, undefined)).toBeNull();
  });

  it('ignores a remembered workspace the person can no longer see', () => {
    expect(currentWorkspace([support], undefined, product.id)).toBe(support);
  });

  it('reads only a well-formed id from the cookie', () => {
    expect(workspaceFromCookie(`a=b; lk_workspace=${product.id}; c=d`)).toBe(product.id);
    expect(workspaceFromCookie('lk_workspace=../../admin')).toBeUndefined();
    expect(workspaceFromCookie(undefined)).toBeUndefined();
  });
});

describe('collapsed layout', () => {
  it('starts full, without cookies or with values it does not know', () => {
    expect(layoutFromCookie(undefined)).toEqual({ rail: false, conversationsHidden: false });
    expect(layoutFromCookie('lk_nav=full; lk_conversations=1')).toEqual({
      rail: false,
      conversationsHidden: false,
    });
  });

  it('reads the menu and the conversation list separately, among other cookies', () => {
    expect(layoutFromCookie('a=b; lk_nav=rail')).toEqual({
      rail: true,
      conversationsHidden: false,
    });
    expect(layoutFromCookie('lk_conversations=hidden; c=d')).toEqual({
      rail: false,
      conversationsHidden: true,
    });
    expect(layoutFromCookie('lk_nav=rail; lk_conversations=hidden')).toEqual({
      rail: true,
      conversationsHidden: true,
    });
  });
});
