import { t } from '../../i18n/index.ts';

/**
 * The wordmark: a Cloudberry dot, then the lowercase name, as drawn. Cloudberry is 2.2:1 on
 * white, so it is only ever this decoration (docs/design/docs/tokens.md). The name is 18px with
 * tight tracking, as drawn: a logo, outside the type scale, as the recovery key is.
 */
export function Brand() {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="size-2.75 shrink-0 rounded-full bg-lk-cloudberry" />
      <span className="text-lg font-semibold tracking-[-0.02em]">{t('nav.brand')}</span>
    </span>
  );
}
