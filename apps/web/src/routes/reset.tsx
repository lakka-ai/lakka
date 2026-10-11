import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { buttonVariants } from '@heroui/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH, PASSWORD_RESET_TOKEN_PATTERN } from '@lakka/contracts';
import type { PasswordResetPreview } from '@lakka/contracts';
import {
  FormAlert,
  PasswordField,
  PublicHeading,
  PublicIcon,
  PublicPage,
} from '../components/public/public.tsx';
import { SafeForm, SubmitButton } from '../components/safe-form.tsx';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { api, ApiError } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { forgetFragmentToken, readFragmentToken } from '../lib/fragment-token.ts';

/*
 * Choosing a new password from a reset link an instance admin made (ID-2, ADR 0098). Not drawn;
 * it follows the invite page. The token is in the fragment (/reset#token). The page says whose
 * password it sets before the field, and a link that does not work is a page with one action.
 * Setting the password signs the person out everywhere, so they sign in again after.
 */

export const Route = createFileRoute('/reset')({ component: Reset });

const STORAGE_KEY = 'lakka.reset';

function Reset() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => setToken(readFragmentToken(STORAGE_KEY, PASSWORD_RESET_TOKEN_PATTERN)), []);
  if (token === undefined) {
    return (
      <PublicPage>
        <p role="status">{t('reset.loading')}</p>
      </PublicPage>
    );
  }
  if (token === null) return <LinkDoesNotWork />;
  return <ResetFor token={token} />;
}

function LinkDoesNotWork() {
  return (
    <PublicPage>
      <PublicIcon tone="danger" />
      <PublicHeading focusOnMount>{t('reset.invalid.heading')}</PublicHeading>
      <p>{t('reset.invalid.body')}</p>
      <Link
        to="/sign-in"
        className={`${buttonVariants({ variant: 'outline', size: 'lg' })} self-start`}
      >
        {t('public.goToSignIn')}
      </Link>
    </PublicPage>
  );
}

function ResetFor({ token }: { token: string }) {
  const preview = useQuery({
    queryKey: ['reset-preview', token],
    queryFn: () =>
      api<PasswordResetPreview>('/api/password-reset/preview', { method: 'POST', body: { token } }),
    retry: false,
  });
  const [short, setShort] = useState(false);
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);

  if (preview.isPending) {
    return (
      <PublicPage>
        <p role="status">{t('reset.loading')}</p>
      </PublicPage>
    );
  }
  if (preview.isError) {
    return preview.error instanceof ApiError && preview.error.code === 'reset_invalid' ? (
      <LinkDoesNotWork />
    ) : (
      <PublicPage>
        <FormAlert title={t('app.error')} />
      </PublicPage>
    );
  }
  if (done) {
    return (
      <PublicPage>
        <PublicIcon tone="success" />
        <PublicHeading focusOnMount>{t('reset.done.heading')}</PublicHeading>
        <p>{t('reset.done.body')}</p>
        <Link
          to="/sign-in"
          className={`${buttonVariants({ variant: 'primary', size: 'lg' })} self-start`}
        >
          {t('public.goToSignIn')}
        </Link>
      </PublicPage>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get('password') ?? '');
    setFailed(null);
    if (password.length < PASSWORD_MIN_LENGTH) {
      setShort(true);
      requestAnimationFrame(() =>
        form.querySelector<HTMLInputElement>('[name="password"]')?.focus(),
      );
      return;
    }
    setShort(false);
    setWorking(true);
    try {
      await api('/api/password-reset', { method: 'POST', body: { token, password } });
      forgetFragmentToken(STORAGE_KEY);
      setDone(true);
    } catch (e) {
      setFailed(
        e instanceof ApiError && e.code === 'reset_invalid'
          ? 'reset.usedMeanwhile'
          : e instanceof ApiError && e.code === 'rate_limited'
            ? 'public.throttled'
            : 'app.error',
      );
      setWorking(false);
    }
  }

  return (
    <PublicPage>
      <div className="flex flex-col gap-1.5">
        <PublicHeading>{t('reset.heading')}</PublicHeading>
        <p>
          {t('reset.body', {
            name: preview.data.displayName,
            email: preview.data.email,
            date: formatDateTime(preview.data.expiresAt),
          })}
        </p>
      </div>
      {failed !== null && <FormAlert title={t(failed)} />}
      <SafeForm
        className="flex flex-col gap-4"
        validationBehavior="aria"
        onSubmit={(e) => void onSubmit(e)}
      >
        {/* For password managers: which account the new password belongs to. */}
        <input type="hidden" name="username" autoComplete="username" value={preview.data.email} />
        <PasswordField
          name="password"
          label={t('reset.password')}
          autoComplete="new-password"
          description={t('public.passwordHelp', { n: String(PASSWORD_MIN_LENGTH) })}
          {...(short
            ? { error: t('public.passwordShort', { n: String(PASSWORD_MIN_LENGTH) }) }
            : {})}
        />
        <SubmitButton size="lg" variant="primary" isPending={working} fullWidth>
          {t('reset.submit')}
        </SubmitButton>
      </SafeForm>
    </PublicPage>
  );
}
