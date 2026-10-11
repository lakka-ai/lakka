import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, buttonVariants, FieldError, Input, Label, TextField } from '@heroui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { INVITE_TOKEN_PATTERN, PASSWORD_MIN_LENGTH } from '@lakka/contracts';
import type { AcceptedInvite, InvitePreview } from '@lakka/contracts';
import {
  FormAlert,
  OrDivider,
  PasswordField,
  PublicHeading,
  PublicIcon,
  PublicPage,
} from '../components/public/public.tsx';
import { SafeForm, SubmitButton } from '../components/safe-form.tsx';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { api, ApiError } from '../lib/api.ts';
import { formatDay } from '../lib/format.ts';
import { forgetFragmentToken, readFragmentToken } from '../lib/fragment-token.ts';
import { meQuery, publicSsoProvidersQuery } from '../lib/queries.ts';
import { startSso } from '../lib/sso.ts';

/*
 * Accepting an invite link (ID-7, ADR 0035, ADR 0098; Public-Invite, Public-Member and
 * Public-Expired boards). The token is in the link's fragment (/invite#token), not in the path
 * the board draws, so it never reaches a server. The workspace and the role are in the heading
 * and the first sentence, before any field. A link that does not work, and a link for a
 * workspace you are in already, are pages with one action each, whose heading takes focus.
 */

export const Route = createFileRoute('/invite')({ component: Invite });

const STORAGE_KEY = 'lakka.invite';

function messageFor(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) return 'app.error';
  if (error.code === 'email_taken') return 'invite.emailTaken';
  if (error.code === 'rate_limited') return 'public.throttled';
  return 'app.error';
}

function Invite() {
  // undefined until the browser has read the fragment; the server cannot see it.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => setToken(readFragmentToken(STORAGE_KEY, INVITE_TOKEN_PATTERN)), []);
  if (token === undefined) {
    return (
      <PublicPage>
        <p role="status">{t('invite.loading')}</p>
      </PublicPage>
    );
  }
  if (token === null) return <LinkDoesNotWork />;
  return <InviteFor token={token} />;
}

function LinkDoesNotWork() {
  return (
    <PublicPage>
      <PublicIcon tone="danger" />
      <PublicHeading focusOnMount>{t('invite.invalid.heading')}</PublicHeading>
      <p>{t('invite.invalid.body')}</p>
      <Link
        to="/sign-in"
        className={`${buttonVariants({ variant: 'outline', size: 'lg' })} self-start`}
      >
        {t('public.goToSignIn')}
      </Link>
    </PublicPage>
  );
}

function WorkspaceChip({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-2 self-start rounded-lg bg-accent-soft py-1 ps-1 pe-3 text-small font-semibold text-accent-soft-foreground">
      <span
        aria-hidden="true"
        className="flex size-5 items-center justify-center rounded-sm bg-accent text-caption text-accent-foreground"
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
      {name}
    </span>
  );
}

function InviteFor({ token }: { token: string }) {
  const preview = useQuery({
    queryKey: ['invite-preview', token],
    queryFn: () => api<InvitePreview>('/api/invites/preview', { method: 'POST', body: { token } }),
    retry: false,
  });
  const me = useQuery({ ...meQuery, retry: false });

  if (preview.isPending || me.isPending) {
    return (
      <PublicPage>
        <p role="status">{t('invite.loading')}</p>
      </PublicPage>
    );
  }
  if (preview.isError) {
    return preview.error instanceof ApiError && preview.error.code === 'invite_invalid' ? (
      <LinkDoesNotWork />
    ) : (
      <PublicPage>
        <FormAlert title={t('app.error')} />
      </PublicPage>
    );
  }
  const invite = preview.data;
  const role = invite.role === 'admin' ? t('invite.anAdmin') : t('invite.aMember');

  if (invite.alreadyMember !== null) {
    const joined = invite.alreadyMember;
    return (
      <PublicPage>
        <PublicIcon tone="success" />
        <PublicHeading focusOnMount>
          {t('invite.member.heading', { workspace: invite.workspaceName })}
        </PublicHeading>
        <p>
          {t('invite.member.body', {
            date: formatDay(joined.joinedAt),
            role: joined.role === 'admin' ? t('invite.anAdmin') : t('invite.aMember'),
          })}
        </p>
        <Link
          to="/workspaces/$workspaceId"
          params={{ workspaceId: joined.workspaceId }}
          className={`${buttonVariants({ variant: 'primary', size: 'lg' })} self-start`}
          onClick={() => forgetFragmentToken(STORAGE_KEY)}
        >
          {t('invite.member.open', { workspace: invite.workspaceName })}
        </Link>
      </PublicPage>
    );
  }

  return (
    <PublicPage>
      <div className="flex flex-col gap-2">
        <WorkspaceChip name={invite.workspaceName} />
        <PublicHeading>{t('invite.heading', { workspace: invite.workspaceName })}</PublicHeading>
        <p>
          {t('invite.body', { name: invite.invitedBy, role })}{' '}
          {invite.role === 'admin' ? t('invite.adminsCan') : t('invite.membersCan')}
        </p>
      </div>
      {me.isSuccess ? (
        <JoinAsMe token={token} name={me.data.displayName} workspace={invite.workspaceName} />
      ) : (
        <NewAccount token={token} />
      )}
    </PublicPage>
  );
}

function useFinish() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async (accepted: AcceptedInvite) => {
    forgetFragmentToken(STORAGE_KEY);
    await queryClient.invalidateQueries();
    await navigate({
      to: '/workspaces/$workspaceId',
      params: { workspaceId: accepted.workspaceId },
    });
  };
}

function JoinAsMe({ token, name, workspace }: { token: string; name: string; workspace: string }) {
  const finish = useFinish();
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const [working, setWorking] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {failed !== null && <FormAlert title={t(failed)} />}
      <Button
        size="lg"
        variant="primary"
        fullWidth
        isPending={working}
        onPress={() => {
          setWorking(true);
          setFailed(null);
          api<AcceptedInvite>('/api/invites/accept', { method: 'POST', body: { token } }).then(
            finish,
            (e: unknown) => {
              setFailed(messageFor(e));
              setWorking(false);
            },
          );
        }}
      >
        {t('invite.joinAs', { workspace, name })}
      </Button>
    </div>
  );
}

type Field = 'name' | 'email' | 'password';

function NewAccount({ token }: { token: string }) {
  const finish = useFinish();
  const providers = useQuery(publicSsoProvidersQuery).data ?? [];
  const [wrong, setWrong] = useState<Field[]>([]);
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const [working, setWorking] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const account = {
      name: String(data.get('name') ?? '').trim(),
      email: String(data.get('email') ?? '').trim(),
      password: String(data.get('password') ?? ''),
    };
    const problems: Field[] = [
      ...(account.name === '' ? (['name'] as const) : []),
      ...(/^\S+@\S+\.\S+$/.test(account.email) ? [] : (['email'] as const)),
      ...(account.password.length < PASSWORD_MIN_LENGTH ? (['password'] as const) : []),
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
      await finish(
        await api<AcceptedInvite>('/api/invites/accept', {
          method: 'POST',
          body: { token, account },
        }),
      );
    } catch (e) {
      setFailed(messageFor(e));
      setWorking(false);
    }
  }

  const invalid = (f: Field) => wrong.includes(f);
  return (
    <>
      <section aria-labelledby="new-heading" className="flex flex-col gap-4">
        <h2 id="new-heading" className="text-heading">
          {t('invite.new.heading')}
        </h2>
        {failed !== null && <FormAlert title={t(failed)} />}
        <SafeForm
          className="flex flex-col gap-4"
          validationBehavior="aria"
          onSubmit={(e) => void onSubmit(e)}
        >
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
          <SubmitButton size="lg" variant="primary" isPending={working} fullWidth>
            {t('invite.new.submit')}
          </SubmitButton>
        </SafeForm>
      </section>
      <OrDivider />
      <section aria-labelledby="existing-heading" className="flex flex-col gap-3">
        <h2 id="existing-heading" className="text-heading">
          {t('invite.existing.heading')}
        </h2>
        {/* Side by side only when there is more than one way in; one fills the row. */}
        <div className={`grid gap-2 ${providers.length > 0 ? 'sm:grid-cols-2' : ''}`}>
          <Link
            to="/sign-in"
            search={{ redirect: '/invite' }}
            className={buttonVariants({ variant: 'outline', fullWidth: true, size: 'lg' })}
          >
            {t('invite.existing.signIn')}
          </Link>
          {providers.map((p) => (
            <Button
              size="lg"
              key={p.providerId}
              variant="outline"
              fullWidth
              onPress={() => {
                void startSso(p.providerId, '/invite').then((ok) => {
                  if (!ok) setFailed('signIn.providerFailed');
                });
              }}
            >
              {t('invite.existing.sso', { name: p.displayName })}
            </Button>
          ))}
        </div>
      </section>
    </>
  );
}
