import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Description, FieldError, Input, Label, TextField } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH } from '@lakka/contracts';
import type { SetupResult } from '@lakka/contracts';
import {
  FormAlert,
  PasswordField,
  PublicHeading,
  PublicPage,
} from '../components/public/public.tsx';
import { SetupSteps, useSetup } from '../components/public/setup.tsx';
import { slugFor } from '../lib/slug.ts';
import { SafeForm, SubmitButton } from '../components/safe-form.tsx';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { api, ApiError } from '../lib/api.ts';

/*
 * Setup, step 3 (Setup-3-Account board): the first instance admin and the first workspace. The
 * workspace's name for links is made from its name, as the board asks for no second field; a
 * fresh server has no other workspace for it to clash with. The form is checked on submit, and
 * focus moves to the first field with a problem.
 */

export const Route = createFileRoute('/setup/account')({ component: SetupAccount });

type Field = 'name' | 'email' | 'password' | 'workspaceName';

function SetupAccount() {
  const setup = useSetup();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [wrong, setWrong] = useState<Field[]>([]);
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const [working, setWorking] = useState(false);
  const code = setup.code;

  useEffect(() => {
    if (code === null) void navigate({ to: '/setup/code', replace: true });
  }, [code, navigate]);
  if (code === null) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: Field) => String(data.get(name) ?? '').trim();
    const password = String(data.get('password') ?? '');
    const problems: Field[] = [
      ...(text('name') === '' ? (['name'] as const) : []),
      ...(/^\S+@\S+\.\S+$/.test(text('email')) ? [] : (['email'] as const)),
      ...(password.length < PASSWORD_MIN_LENGTH ? (['password'] as const) : []),
      ...(text('workspaceName') === '' ? (['workspaceName'] as const) : []),
    ];
    setWrong(problems);
    setFailed(null);
    if (problems.length > 0) {
      requestAnimationFrame(() =>
        form.querySelector<HTMLInputElement>(`[name="${problems[0] ?? ''}"]`)?.focus(),
      );
      return;
    }
    setWorking(true);
    try {
      const { workspace } = await api<SetupResult>('/api/setup', {
        method: 'POST',
        body: {
          code,
          admin: { name: text('name'), email: text('email'), password },
          workspace: { name: text('workspaceName'), slug: slugFor(text('workspaceName')) },
        },
      });
      await queryClient.invalidateQueries();
      await navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: workspace.id } });
    } catch (e) {
      setFailed(
        e instanceof ApiError && e.code === 'email_taken'
          ? 'setup.emailTaken'
          : e instanceof ApiError && e.code === 'setup_complete'
            ? 'setup.done'
            : e instanceof ApiError && e.code === 'rate_limited'
              ? 'public.throttled'
              : 'app.error',
      );
      setWorking(false);
    }
  }

  const invalid = (f: Field) => wrong.includes(f);
  return (
    <PublicPage above={<SetupSteps current="account" />} width="wide">
      <div className="flex flex-col gap-1.5">
        <PublicHeading focusOnMount={setup.moved}>{t('setup.account.heading')}</PublicHeading>
        <p className="text-muted">{t('setup.account.intro')}</p>
      </div>
      {failed !== null && <FormAlert title={t(failed)} />}
      <SafeForm
        onSubmit={(e) => void submit(e)}
        validationBehavior="aria"
        className="flex flex-col gap-6"
      >
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-3 text-heading">{t('setup.account.you')}</legend>
          <TextField name="name" autoComplete="name" isInvalid={invalid('name')}>
            <Label>{t('public.name')}</Label>
            <Input />
            {invalid('name') && <FieldError>{t('public.nameMissing')}</FieldError>}
          </TextField>
          <TextField name="email" type="email" autoComplete="username" isInvalid={invalid('email')}>
            <Label>{t('public.email')}</Label>
            <Input spellCheck={false} />
            {invalid('email') && <FieldError>{t('public.emailInvalid')}</FieldError>}
          </TextField>
          <PasswordField
            name="password"
            label={t('public.password')}
            autoComplete="new-password"
            description={t('public.passwordHelp', { n: String(PASSWORD_MIN_LENGTH) })}
            {...(invalid('password')
              ? { error: t('public.passwordShort', { n: String(PASSWORD_MIN_LENGTH) }) }
              : {})}
          />
        </fieldset>
        <fieldset className="flex flex-col gap-4 border-t border-separator pt-5">
          <legend className="float-left mb-3 text-heading">{t('setup.account.workspace')}</legend>
          <TextField
            name="workspaceName"
            isInvalid={invalid('workspaceName')}
            maxLength={100}
            className="clear-left"
          >
            <Label>{t('setup.account.workspaceName')}</Label>
            <Input />
            {invalid('workspaceName') ? (
              <FieldError>{t('setup.account.workspaceMissing')}</FieldError>
            ) : (
              <Description>{t('setup.account.workspaceHelp')}</Description>
            )}
          </TextField>
        </fieldset>
        <SubmitButton size="lg" variant="primary" isPending={working} fullWidth>
          {t('setup.account.submit')}
        </SubmitButton>
      </SafeForm>
    </PublicPage>
  );
}
