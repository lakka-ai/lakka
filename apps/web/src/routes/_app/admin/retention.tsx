import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { LastRun, Periods, TraceExport } from '../../../components/admin/retention.tsx';
import { t } from '../../../i18n/index.ts';
import { retentionQuery, traceExportQuery } from '../../../lib/queries.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/* How long records are kept, for the whole instance (OB-6, NF-P5, ADR 0078, ADR 0097). */

export const Route = createFileRoute('/_app/admin/retention')({
  beforeLoad: ({ context }) => {
    if (!context.me.isInstanceAdmin) throw redirect({ to: '/' });
  },
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(retentionQuery),
      context.queryClient.ensureQueryData(traceExportQuery),
    ]),
  component: RetentionPage,
});

function RetentionPage() {
  const { data: retention } = useSuspenseQuery(retentionQuery);
  const { data: exporting } = useSuspenseQuery(traceExportQuery);
  return (
    <>
      <PageHeader title={t('admin.retention.title')} lede={t('admin.retention.intro')} />
      <Periods retention={retention} />
      <LastRun retention={retention} />
      <TraceExport status={exporting} />
    </>
  );
}
