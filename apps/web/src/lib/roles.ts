import type { WorkspaceRole, WorkspaceView } from '@lakka/contracts';
import { t } from '../i18n/index.ts';

/** Your role in a workspace, as a short label. */
export const roleLabel = (role: WorkspaceView['role']): string =>
  role === 'admin'
    ? t('workspaces.role.admin')
    : role === 'member'
      ? t('workspaces.role.member')
      : t('workspaces.role.none');

/**
 * Whether the caller sees a workspace as its admin: a workspace admin, or an instance admin who
 * is not a member of it (their role is null). The api decides; this only picks the page.
 */
export const isAdminRole = (role: WorkspaceRole | null) => role === 'admin' || role === null;
