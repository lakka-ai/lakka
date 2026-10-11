import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Description, FieldError, Input, Label, TextField } from '@heroui/react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import type { SetupSecrets } from '@lakka/contracts';
import { Icon } from '../components/icons.tsx';
import { FormAlert, PublicHeading, PublicPage } from '../components/public/public.tsx';
import { SetupSteps, useSetup } from '../components/public/setup.tsx';
import { SafeForm, SubmitButton } from '../components/safe-form.tsx';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { api, ApiError } from '../lib/api.ts';

/*
 * Setup, step 1 (Setup-1-Code board): the command that prints the setup code, and the code.
 * A wrong code is an inline error tied to the field, and what was typed stays.
 */

export const Route = createFileRoute('/setup/code')({ component: SetupCode });

/**
 * Where the code comes from. Under `pnpm dev` the api runs on this machine rather than in a
 * container, so the Docker command would find nothing; the development build says so.
 */
const COMMAND = import.meta.env.DEV
  ? 'pnpm setup-code'
  : 'docker compose exec api lakka setup-code';

function SetupCode() {
  const setup = useSetup();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [wrong, setWrong] = useState(false);
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entered = code.trim();
    setWrong(false);
    setFailed(null);
    if (entered === '') {
      setWrong(true);
      return;
    }
    setWorking(true);
    try {
      const secrets = await api<SetupSecrets>('/api/setup/secrets', {
        method: 'POST',
        body: { code: entered },
      });
      setup.proved(entered, secrets.credentialMasterKey);
      await navigate({ to: '/setup/recovery-key' });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_setup_code') setWrong(true);
      else if (e instanceof ApiError && e.code === 'setup_complete') setFailed('setup.done');
      else if (e instanceof ApiError && e.code === 'rate_limited') setFailed('public.throttled');
      else setFailed('app.error');
      setWorking(false);
    }
  }

  return (
    <PublicPage above={<SetupSteps current="code" />} below={t('setup.code.three')} width="wide">
      <div className="flex flex-col gap-2">
        <PublicHeading focusOnMount={setup.moved}>{t('setup.code.heading')}</PublicHeading>
        <p className="text-muted">{t('setup.code.intro')}</p>
      </div>
      {failed !== null && (
        <FormAlert title={t(failed)}>
          {failed === 'setup.done' && (
            <Link to="/sign-in" className="lk-link">
              {t('public.goToSignIn')}
            </Link>
          )}
        </FormAlert>
      )}
      <div className="flex items-center gap-2 rounded-note bg-foreground py-1.5 ps-4 pe-1.5 text-background">
        <code className="min-w-0 grow font-mono text-body break-words">{COMMAND}</code>
        <Button
          size="lg"
          variant="outline"
          className="lk-on-inverse shrink-0"
          aria-label={t('setup.code.copyCommand')}
          onPress={() => {
            navigator.clipboard.writeText(COMMAND).then(
              () => setCopied(t('common.copied')),
              () => setCopied(t('common.copyFailed')),
            );
          }}
        >
          <Icon name="copy" />
          {t('common.copy')}
        </Button>
      </div>
      <p role="status" className="-mt-3 text-small text-muted empty:hidden">
        {copied}
      </p>
      <SafeForm
        onSubmit={(e) => void submit(e)}
        validationBehavior="aria"
        className="flex flex-col gap-4"
      >
        <TextField name="code" value={code} onChange={setCode} isInvalid={wrong} autoComplete="off">
          <Label>{t('setup.code.label')}</Label>
          <Input
            className="font-mono text-chat tracking-widest"
            spellCheck={false}
            autoCapitalize="none"
          />
          {wrong ? (
            <FieldError>{t('setup.code.wrong')}</FieldError>
          ) : (
            <Description>{t('setup.code.help')}</Description>
          )}
        </TextField>
        <SubmitButton size="lg" variant="primary" isPending={working} className="self-end">
          {t('setup.continue')}
        </SubmitButton>
      </SafeForm>
    </PublicPage>
  );
}
