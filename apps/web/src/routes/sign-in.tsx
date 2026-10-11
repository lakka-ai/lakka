import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Input, Label, TextField } from '@heroui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useLoaderData, useNavigate } from '@tanstack/react-router';
import { Icon } from '../components/icons.tsx';
import {
  FormAlert,
  OrDivider,
  PasswordField,
  PublicHeading,
  PublicPage,
} from '../components/public/public.tsx';
import { SafeForm, SubmitButton } from '../components/safe-form.tsx';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { publicSsoProvidersQuery, setupStatusQuery } from '../lib/queries.ts';
import { startSso } from '../lib/sso.ts';

/*
 * Sign-in (ID-2; Public and Public-Error boards). Identity providers come first, since most
 * people at a company use one, each button naming its provider. Email and password go straight
 * to the api's Better Auth routes. A wrong email or password is one alert above the form that
 * never says which of the two was wrong; the email keeps its value and focus moves to the
 * password. A fresh instance has nobody to sign in yet, so this page sends visitors to setup
 * (AD-1). The only place sign-in returns to, other than home, is the invite page.
 */

interface SignInSearch {
  error?: string;
  redirect?: '/invite';
}

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    ...(typeof search['error'] === 'string' ? { error: search['error'] } : {}),
    ...(search['redirect'] === '/invite' ? { redirect: '/invite' as const } : {}),
  }),
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupStatusQuery);
    if (status.required) throw redirect({ to: '/setup/code' });
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(publicSsoProvidersQuery),
  component: SignIn,
});

type Problem = { title: MessageKey; body?: MessageKey };

function problemFor(status: number, code: string | undefined): Problem {
  if (status === 429) return { title: 'public.throttled' };
  if (code === 'FAILED_TO_CREATE_SESSION') return { title: 'signIn.suspended' };
  return { title: 'signIn.wrong', body: 'signIn.wrongHelp' };
}

function SignIn() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { host } = useLoaderData({ from: '__root__' });
  const { error: providerError, redirect: returnTo } = Route.useSearch();
  const providers = useQuery(publicSsoProvidersQuery).data ?? [];
  const [problem, setProblem] = useState<Problem | null>(
    providerError === undefined ? null : { title: 'signIn.providerFailed' },
  );
  const [email, setEmail] = useState('');
  const [working, setWorking] = useState(false);
  const password = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setWorking(true);
    setProblem(null);
    const response = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password: form.get('password') }),
    });
    setWorking(false);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const code =
        body !== null && typeof body === 'object' && 'code' in body ? String(body.code) : undefined;
      setProblem(problemFor(response.status, code));
      password.current?.focus();
      return;
    }
    await queryClient.invalidateQueries();
    await navigate({ to: returnTo ?? '/' });
  }

  return (
    <PublicPage>
      <div className="flex flex-col gap-1">
        <PublicHeading>{t('signIn.title')}</PublicHeading>
        {host !== '' && <p className="text-body text-muted">{host}</p>}
      </div>
      {problem !== null && (
        <FormAlert title={t(problem.title)}>
          {problem.body === undefined ? undefined : t(problem.body)}
        </FormAlert>
      )}
      {providers.length > 0 && (
        <>
          <div className="flex flex-col gap-2">
            {providers.map((p) => (
              <Button
                size="lg"
                key={p.providerId}
                variant="outline"
                fullWidth
                onPress={() => {
                  setProblem(null);
                  void startSso(p.providerId, returnTo ?? '/').then((ok) => {
                    if (!ok) setProblem({ title: 'signIn.providerFailed' });
                  });
                }}
              >
                <Icon name="signIn" />
                {t('signIn.provider', { name: p.displayName })}
              </Button>
            ))}
          </div>
          <OrDivider />
        </>
      )}
      <SafeForm className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
        <TextField
          name="email"
          type="email"
          isRequired
          autoComplete="username"
          value={email}
          onChange={setEmail}
        >
          <Label>{t('public.email')}</Label>
          <Input spellCheck={false} />
        </TextField>
        <PasswordField
          name="password"
          label={t('public.password')}
          autoComplete="current-password"
          isRequired
          inputRef={password}
        />
        <SubmitButton size="lg" variant="primary" isPending={working} fullWidth>
          {t('signIn.submit')}
        </SubmitButton>
      </SafeForm>
      <p className="text-small text-muted">{t('signIn.forgot')}</p>
    </PublicPage>
  );
}
