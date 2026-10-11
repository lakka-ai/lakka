import { useState } from 'react';
import { Button } from '@heroui/react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { AllowedOrigins, AllowOriginDialog } from '../../../components/admin/tool-servers.tsx';
import { Icon } from '../../../components/icons.tsx';
import { PageHeader } from '../../../components/patterns/page-header.tsx';
import { t } from '../../../i18n/index.ts';
import { mcpOriginsQuery } from '../../../lib/queries.ts';

/*
 * Tool servers (NF-S4, ADR 0117; no board), for instance admins; the api enforces it. Its own
 * item in the Admin group rather than a tab: no admin page is about tools, and a workspace's
 * servers stay on that workspace's Tools page.
 */

export const Route = createFileRoute('/_app/admin/tools')({
  beforeLoad: ({ context }) => {
    if (!context.me.isInstanceAdmin) throw redirect({ to: '/' });
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(mcpOriginsQuery),
  component: ToolServersPage,
});

function ToolServersPage() {
  const { data: allowlist } = useSuspenseQuery(mcpOriginsQuery);
  const [allowing, setAllowing] = useState(false);
  const [status, setStatus] = useState('');
  return (
    <>
      <PageHeader
        title={t('admin.toolServers.title')}
        lede={t('admin.toolServers.intro')}
        actions={
          <Button
            size="lg"
            variant="primary"
            onPress={() => {
              setStatus('');
              setAllowing(true);
            }}
          >
            <Icon name="plus" />
            {t('admin.toolServers.allow')}
          </Button>
        }
      />
      <AllowedOrigins allowlist={allowlist} status={status} onStatus={setStatus} />
      <AllowOriginDialog
        isOpen={allowing}
        onOpenChange={setAllowing}
        onAllowed={(origin) => {
          setAllowing(false);
          setStatus(t('admin.toolServers.wasAllowed', { origin }));
        }}
      />
    </>
  );
}
