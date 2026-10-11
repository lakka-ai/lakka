import { useState } from 'react';
import { buttonVariants } from '@heroui/react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { AlertsCard } from '../../../components/spend/alerts.tsx';
import { Icon } from '../../../components/icons.tsx';
import { CapDialog } from '../../../components/spend/cap-dialog.tsx';
import type { CapTarget } from '../../../components/spend/cap-dialog.tsx';
import { InstanceCapCard } from '../../../components/spend/caps.tsx';
import { NoSpend, WhereTheMoneyWent } from '../../../components/spend/report.tsx';
import { t } from '../../../i18n/index.ts';
import {
  alertHistoryQuery,
  instanceBudgetQuery,
  spendQuery,
  webhookQuery,
} from '../../../lib/queries.ts';
import { rangeDays } from '../../../lib/spend.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/*
 * Instance spend (BG-1, BG-10, BG-11; Admin-Spend board), for instance admins: the instance cap,
 * where this month's money went, with each workspace's own cap, and where the instance cap's
 * alerts go. The full report, with dates to choose, is at /admin/spend/report, opened from the
 * page header.
 */

const thisMonth = () => rangeDays('this-month', new Date());

export const Route = createFileRoute('/_app/admin/spend')({
  beforeLoad: ({ context }) => {
    if (!context.me.isInstanceAdmin) throw redirect({ to: '/' });
  },
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(instanceBudgetQuery),
      context.queryClient.ensureQueryData(webhookQuery(null)),
      context.queryClient.ensureQueryData(alertHistoryQuery(null)),
      context.queryClient.ensureQueryData(spendQuery(null, thisMonth())),
    ]),
  component: InstanceSpend,
});

function InstanceSpend() {
  const { data: budget } = useSuspenseQuery(instanceBudgetQuery);
  const { data: report } = useSuspenseQuery(spendQuery(null, thisMonth()));
  const [editing, setEditing] = useState<CapTarget | null>(null);
  return (
    <>
      <PageHeader
        title={t('admin.spend.title')}
        lede={t('admin.spend.intro')}
        actions={
          <Link
            to="/admin/spend/report"
            className={buttonVariants({ variant: 'tertiary', size: 'lg' })}
          >
            <Icon name="spend" />
            {t('admin.spend.fullReport')}
          </Link>
        }
      />
      <InstanceCapCard
        cap={budget}
        onEdit={() =>
          setEditing({
            kind: 'instance',
            path: '/api/budgets/instance',
            name: t('spend.caps.instance'),
            current: budget,
            canRemove: true,
          })
        }
      />
      {report.requests === 0 ? (
        <NoSpend thisMonth noCap={false} />
      ) : (
        <WhereTheMoneyWent report={report} members={[]} variant="instance" />
      )}
      <AlertsCard workspaceId={null} />
      <CapDialog target={editing} onClose={() => setEditing(null)} />
    </>
  );
}
