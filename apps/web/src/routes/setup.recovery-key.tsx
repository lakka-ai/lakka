import { useEffect, useId, useState } from 'react';
import { Button, Label, TextArea, TextField } from '@heroui/react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Icon } from '../components/icons.tsx';
import { PublicHeading, PublicPage } from '../components/public/public.tsx';
import { SetupSteps, useSetup } from '../components/public/setup.tsx';
import { t } from '../i18n/index.ts';
import { CheckboxOption } from '../components/patterns/settings.tsx';
import { WarningNote } from '../components/patterns/notices.tsx';

/*
 * Setup, step 2 (Setup-2-Recovery board): the recovery key, shown once, in a read-only text area
 * so it can be selected, with Copy, which announces that it copied, and Download. Continue uses
 * aria-disabled until "I have saved" is ticked, and says why to a screen reader only.
 */

export const Route = createFileRoute('/setup/recovery-key')({ component: RecoveryKey });

function download(text: string) {
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lakka-recovery-key.txt';
  a.click();
  URL.revokeObjectURL(url);
}

function RecoveryKey() {
  const setup = useSetup();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState('');
  const why = useId();
  const key = setup.recoveryKey;

  // Without the code there is nothing to show: start again at step 1.
  useEffect(() => {
    if (key === null) void navigate({ to: '/setup/code', replace: true });
  }, [key, navigate]);
  if (key === null) return null;

  return (
    <PublicPage above={<SetupSteps current="recoveryKey" />} width="wide">
      <div className="flex flex-col gap-1.5">
        <PublicHeading focusOnMount={setup.moved}>{t('setup.key.heading')}</PublicHeading>
        <p className="text-muted">{t('setup.key.intro')}</p>
      </div>
      <WarningNote>
        <p>
          <strong className="font-semibold">{t('setup.key.once')}</strong> {t('setup.key.store')}
        </p>
      </WarningNote>
      <div className="flex flex-col gap-2">
        <TextField isReadOnly value={key}>
          <Label>{t('setup.key.label')}</Label>
          <TextArea
            rows={2}
            spellCheck={false}
            className="resize-none bg-surface-secondary lk-key break-all"
          />
        </TextField>
        <div className="flex flex-wrap gap-2">
          <Button
            size="lg"
            variant="tertiary"
            onPress={() => {
              navigator.clipboard.writeText(key).then(
                () => setCopied(t('common.copied')),
                () => setCopied(t('common.copyFailed')),
              );
            }}
          >
            <Icon name="copy" />
            {t('common.copy')}
          </Button>
          <Button size="lg" variant="tertiary" onPress={() => download(key)}>
            <Icon name="download" />
            {t('setup.key.download')}
          </Button>
        </div>
        <p role="status" className="text-small text-muted empty:hidden">
          {copied}
        </p>
      </div>
      <CheckboxOption isSelected={saved} onChange={setSaved} label={t('setup.key.saved')} />
      <div className="flex items-center justify-end gap-3">
        {!saved && (
          <span id={why} className="sr-only">
            {t('setup.key.tick')}
          </span>
        )}
        <Button
          size="lg"
          variant="primary"
          aria-disabled={!saved}
          {...(saved ? {} : { 'aria-describedby': why })}
          className="aria-disabled:cursor-not-allowed"
          onPress={() => {
            if (!saved) return;
            setup.saved();
            void navigate({ to: '/setup/account' });
          }}
        >
          {t('setup.continue')}
        </Button>
      </div>
    </PublicPage>
  );
}
