import { t } from '../../i18n/index.ts';

/*
 * The AGPL notice (AD-6, AGPL section 13, ADR 0085): a link to the source of the version
 * running, and the sentence that says why it is there. The footer of the signed-out pages
 * (setup, sign in, invites, reset links). Signed-in pages have it in the account menu
 * (ADR 0107).
 */
export function SourceNotice({ sourceUrl }: { sourceUrl: string }) {
  return (
    <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-4 text-small [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center lg:[&_a]:min-h-0">
      <a href={sourceUrl} className="lk-link">
        {t('app.source')}
      </a>
      <span className="text-muted">{t('app.license')}</span>
    </footer>
  );
}
