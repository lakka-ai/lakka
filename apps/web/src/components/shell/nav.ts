import { linkOptions } from '@tanstack/react-router';
import type { Principal, WorkspaceView } from '@lakka/contracts';
import type { MessageKey } from '../../i18n/index.ts';
import type { IconName } from '../icons.tsx';

/*
 * What the main menu offers, in one place for the side menu and the phone drawer
 * (docs/design/docs/screens.md, App shell). Chat comes first and apart; then the workspace
 * pages; then, for instance admins, the Admin group.
 *
 * This only decides what is linked. The server decides what anyone may see: a member who
 * opens an admin address gets nothing from the api, whatever the menu shows.
 */

export type NavKey =
  | 'chat'
  | 'spend'
  | 'requests'
  | 'routing'
  | 'tools'
  | 'connections'
  | 'workspace'
  | 'workspaces'
  | 'peopleAndSignIn'
  | 'modelsAndProviders'
  | 'toolServers'
  | 'instanceSpend'
  | 'retention'
  | 'diagnostics';

const workspaceLinks = (workspaceId: string) => {
  const params = { workspaceId };
  return {
    chat: linkOptions({ to: '/workspaces/$workspaceId/chat', params }),
    spend: linkOptions({ to: '/workspaces/$workspaceId/spend', params }),
    requests: linkOptions({ to: '/workspaces/$workspaceId/requests', params }),
    routing: linkOptions({ to: '/workspaces/$workspaceId/routing', params }),
    tools: linkOptions({ to: '/workspaces/$workspaceId/tools', params }),
    connections: linkOptions({ to: '/workspaces/$workspaceId/connections', params }),
    // Every other workspace address starts with this one, so only an exact match is current.
    workspace: linkOptions({
      to: '/workspaces/$workspaceId',
      params,
      activeOptions: { exact: true },
    }),
  };
};

const adminLinks = {
  workspaces: linkOptions({ to: '/admin/workspaces' }),
  // Each opens its first tab; the second tab's address starts with it, so it is current there too.
  peopleAndSignIn: linkOptions({ to: '/admin/people' }),
  modelsAndProviders: linkOptions({ to: '/admin/models' }),
  toolServers: linkOptions({ to: '/admin/tools' }),
  // The full report at /admin/spend/report is part of Instance spend.
  instanceSpend: linkOptions({ to: '/admin/spend' }),
  retention: linkOptions({ to: '/admin/retention' }),
  diagnostics: linkOptions({ to: '/admin/diagnostics' }),
};

type WorkspaceLink = ReturnType<typeof workspaceLinks>[keyof ReturnType<typeof workspaceLinks>];
type AdminLink = (typeof adminLinks)[keyof typeof adminLinks];

export interface NavItem {
  key: NavKey;
  label: MessageKey;
  icon: IconName;
  link: WorkspaceLink | AdminLink;
}

const item = (key: NavKey, label: MessageKey, icon: IconName, link: NavItem['link']): NavItem => ({
  key,
  label,
  icon,
  link,
});

export interface NavModel {
  /** Null when there is no workspace to chat in. */
  chat: NavItem | null;
  workspace: NavItem[];
  /** Empty unless the person is an instance admin. */
  admin: NavItem[];
}

/**
 * Routing and Tools are for people who manage the workspace: its admins, and instance admins,
 * who may manage every workspace (ID-6). Members read about routing on the Routing page if
 * they open it; the menu does not offer it (screens.md).
 */
export function navModel(
  me: Pick<Principal, 'isInstanceAdmin'>,
  workspace: Pick<WorkspaceView, 'id' | 'role'> | null,
): NavModel {
  const manages = workspace !== null && (workspace.role === 'admin' || me.isInstanceAdmin);
  const links = workspace === null ? null : workspaceLinks(workspace.id);
  return {
    chat: links === null ? null : item('chat', 'nav.chat', 'chat', links.chat),
    workspace:
      links === null
        ? []
        : [
            item('spend', 'nav.spendAndBudgets', 'spend', links.spend),
            item('requests', 'nav.requests', 'requests', links.requests),
            ...(manages
              ? [
                  item('routing', 'nav.routing', 'routing', links.routing),
                  item('tools', 'nav.tools', 'tools', links.tools),
                ]
              : []),
            item('connections', 'nav.connections', 'connections', links.connections),
            item('workspace', 'nav.workspace', 'settings', links.workspace),
          ],
    admin: me.isInstanceAdmin
      ? [
          item('workspaces', 'nav.workspaces', 'workspaces', adminLinks.workspaces),
          item('peopleAndSignIn', 'nav.peopleAndSignIn', 'signIn', adminLinks.peopleAndSignIn),
          item(
            'modelsAndProviders',
            'nav.modelsAndProviders',
            'modelProviders',
            adminLinks.modelsAndProviders,
          ),
          item('toolServers', 'nav.toolServers', 'lock', adminLinks.toolServers),
          item('instanceSpend', 'nav.spend', 'instanceSpend', adminLinks.instanceSpend),
          item('retention', 'nav.retention', 'retention', adminLinks.retention),
          item('diagnostics', 'nav.diagnostics', 'diagnostics', adminLinks.diagnostics),
        ]
      : [],
  };
}

/** Every item, in menu order. */
export const navItems = (model: NavModel): NavItem[] => [
  ...(model.chat === null ? [] : [model.chat]),
  ...model.workspace,
  ...model.admin,
];

/**
 * The workspace to show in the menu: the one in the address, else the one used last, else the
 * first one the person belongs to, else any they can see.
 */
export function currentWorkspace<W extends Pick<WorkspaceView, 'id' | 'role'>>(
  workspaces: readonly W[],
  fromAddress: string | undefined,
  remembered: string | undefined,
): W | null {
  const byId = (id: string | undefined) =>
    id === undefined ? undefined : workspaces.find((w) => w.id === id);
  return (
    byId(fromAddress) ??
    byId(remembered) ??
    workspaces.find((w) => w.role !== null) ??
    workspaces[0] ??
    null
  );
}
