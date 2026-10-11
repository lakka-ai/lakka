import { createFileRoute, redirect } from '@tanstack/react-router';
import { currentWorkspace } from '../../components/shell/nav.ts';
import { workspacesQuery } from '../../lib/queries.ts';

/*
 * `/` opens chat in the workspace used last, or the first one the person belongs to. Someone
 * in no workspace gets the workspace list, which says what to do, and links an instance admin
 * to where workspaces are created. The MCP authorization flow lands here when it cannot tell which workspace it
 * was for; its outcome is shown on the list.
 */

export const Route = createFileRoute('/_app/')({
  beforeLoad: async ({ context, search }) => {
    const mcp = (search as Record<string, unknown>)['mcp'];
    if (mcp === 'denied' || mcp === 'failed') {
      throw redirect({ to: '/workspaces', search: { mcp } });
    }
    const workspaces = await context.queryClient.ensureQueryData(workspacesQuery);
    const workspace = currentWorkspace(workspaces, undefined, context.rememberedWorkspaceId);
    if (workspace === null) throw redirect({ to: '/workspaces' });
    throw redirect({
      to: '/workspaces/$workspaceId/chat',
      params: { workspaceId: workspace.id },
    });
  },
});
