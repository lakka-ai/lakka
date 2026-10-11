import { buttonVariants } from '@heroui/react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Icon } from '../../../components/icons.tsx';
import { CardSection } from '../../../components/patterns/card-section.tsx';
import { CodeBlock } from '../../../components/patterns/code-block.tsx';
import { InfoNote } from '../../../components/patterns/notices.tsx';
import { t } from '../../../i18n/index.ts';
import { PageHeader } from '../../../components/patterns/page-header.tsx';

/*
 * The diagnostics bundle (AD-3, ADR 0083; Admin-Diagnostics board): what it holds, the note on
 * what is removed, read before the download, and the download. The bundle is a tar.gz, not the
 * zip the board says. The same bundle comes from `lakka diagnostics` in the api container
 * when this page cannot be reached.
 */

export const Route = createFileRoute('/_app/admin/diagnostics')({
  beforeLoad: ({ context }) => {
    if (!context.me.isInstanceAdmin) throw redirect({ to: '/' });
  },
  component: DiagnosticsPage,
});

function DiagnosticsPage() {
  return (
    <>
      <PageHeader title={t('admin.diagnostics.title')} lede={t('admin.diagnostics.intro')} />
      <CardSection title={t('admin.diagnostics.bundle')} titleId="bundle-heading">
        <p>{t('admin.diagnostics.holds')}</p>
        <InfoNote icon="lock" className="self-start">
          {t('admin.diagnostics.removed')}
        </InfoNote>
        <a
          className={`${buttonVariants({ variant: 'primary', size: 'lg' })} self-start`}
          href="/api/diagnostics"
          download
        >
          <Icon name="download" />
          {t('admin.diagnostics.download')}
        </a>
        <p className="text-small text-muted">{t('admin.diagnostics.nothingSent')}</p>
        <p className="text-small text-muted">{t('admin.diagnostics.command')}</p>
        <CodeBlock>
          docker compose exec -T api lakka diagnostics &gt; lakka-diagnostics.tar.gz
        </CodeBlock>
      </CardSection>
    </>
  );
}
