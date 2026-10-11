import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Description, FieldError, Input, Label, TextField } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SsoProviderView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import { Icon } from '../icons.tsx';
import { SafeForm, SubmitButton } from '../safe-form.tsx';
import { CardSection } from '../patterns/card-section.tsx';
import { ConfirmDialog, TypedConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { WriteOnlyField } from '../patterns/fields.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { CheckboxSetting } from '../patterns/settings.tsx';
import { StatusChip } from '../patterns/status-chip.tsx';
import { TagsField } from '../patterns/tags-field.tsx';

/*
 * Sign-in providers (ID-2, AD-1, ADR 0032, ADR 0097; Admin-Signin board). One form per OIDC
 * provider. The client secret is write-only. The provider id, issuer and client id are fixed
 * once the provider exists, because they decide who a sign-in is; they read as read-only fields
 * that say so. The redirect URI is read-only with Copy, which announces that it copied. "Let this
 * provider create new accounts" is a checkbox, applied by Save provider. Remove provider sits
 * bottom left and asks first: when people sign in with nothing else, they must type the
 * provider's id, since they are locked out until it is added again with that id.
 */

const PROVIDER_ID = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function CopyValue({ label, value, help }: { label: string; value: string; help: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <TextField isReadOnly value={value} className="min-w-0 grow">
          <Label>{label}</Label>
          <Input className="font-mono" />
        </TextField>
        <Button
          size="lg"
          variant="tertiary"
          onPress={() => {
            navigator.clipboard.writeText(value).then(
              () => setCopied('yes'),
              () => setCopied('failed'),
            );
          }}
        >
          <Icon name="copy" />
          {t('common.copy')}
        </Button>
      </div>
      <p className="text-small text-muted">{help}</p>
      <p role="status" className="sr-only">
        {copied === 'yes' ? t('common.copied') : copied === 'failed' ? t('common.copyFailed') : ''}
      </p>
    </div>
  );
}

function Fixed({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <TextField isReadOnly value={value}>
      <Label>{label}</Label>
      <Input className="bg-surface-secondary" spellCheck={false} />
      <Description>{help}</Description>
    </TextField>
  );
}

/** The api keeps at most 50 allowed domains a provider. */
const MAX_DOMAINS = 50;

/**
 * The allowed email domains, typed one at a time (ADR 0109). A domain is kept in lower case, as
 * the api checks it.
 */
function Domains({ domains, onChange }: { domains: string[]; onChange: (d: string[]) => void }) {
  return (
    <TagsField
      label={t('admin.signIn.domains')}
      description={t('admin.signIn.domainsHelp')}
      placeholder={t('admin.signIn.domainsAny')}
      findLabel={t('admin.signIn.findDomain')}
      findPlaceholder={t('admin.signIn.findDomainPlaceholder')}
      value={domains}
      onChange={onChange}
      parse={(text) => {
        const domain = text.trim().toLowerCase();
        return DOMAIN.test(domain) ? domain : undefined;
      }}
      removeLabel={(d) => t('admin.signIn.removeDomain', { domain: d })}
      hint={t('admin.signIn.domainHint')}
      invalid={t('admin.signIn.domainInvalid')}
      max={MAX_DOMAINS}
    />
  );
}

interface Draft {
  providerId: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowSignUp: boolean;
  allowedEmailDomains: string[];
}

const draftOf = (p: SsoProviderView | null): Draft => ({
  providerId: p?.providerId ?? '',
  displayName: p?.displayName ?? '',
  issuer: p?.issuer ?? '',
  clientId: p?.clientId ?? '',
  clientSecret: '',
  allowSignUp: p?.allowSignUp ?? false,
  allowedEmailDomains: p?.allowedEmailDomains ?? [],
});

type Problem = 'providerId' | 'displayName' | 'issuer' | 'clientId' | 'clientSecret';

function problemsOf(draft: Draft, isNew: boolean): Problem[] {
  const problems: Problem[] = [];
  if (isNew && !PROVIDER_ID.test(draft.providerId)) problems.push('providerId');
  if (draft.displayName.trim() === '') problems.push('displayName');
  if (isNew && !/^https?:\/\/\S+$/.test(draft.issuer.trim())) problems.push('issuer');
  if (isNew && draft.clientId.trim() === '') problems.push('clientId');
  if (isNew && draft.clientSecret === '') problems.push('clientSecret');
  return problems;
}

export function ProviderForm({
  provider,
  onCancelNew,
  onSaved,
}: {
  /** Null for a provider being added. */
  provider: SsoProviderView | null;
  onCancelNew?: () => void;
  onSaved: (message: string) => void;
}) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const isNew = provider === null;
  const [draft, setDraft] = useState<Draft>(() => draftOf(provider));
  const [shown, setShown] = useState<Problem[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const set =
    <K extends keyof Draft>(key: K) =>
    (value: Draft[K]) =>
      setDraft((d) => ({ ...d, [key]: value }));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sso-providers'] });

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api('/api/sso/providers', {
            method: 'POST',
            body: {
              providerId: draft.providerId,
              displayName: draft.displayName.trim(),
              issuer: draft.issuer.trim(),
              clientId: draft.clientId.trim(),
              clientSecret: draft.clientSecret,
              allowSignUp: draft.allowSignUp,
              allowedEmailDomains: draft.allowedEmailDomains,
            },
          })
        : api(`/api/sso/providers/${provider.providerId}`, {
            method: 'PUT',
            body: {
              displayName: draft.displayName.trim(),
              allowSignUp: draft.allowSignUp,
              allowedEmailDomains: draft.allowedEmailDomains,
              ...(draft.clientSecret === '' ? {} : { clientSecret: draft.clientSecret }),
            },
          }),
    onSuccess: async () => {
      setDraft((d) => ({ ...d, clientSecret: '' }));
      await refresh();
      onSaved(t('admin.signIn.saved', { name: draft.displayName.trim() }));
    },
    onError: (e) =>
      setFailed(
        isNew && e instanceof ApiError && e.status === 400
          ? t('admin.signIn.addFailed')
          : t('app.error'),
      ),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/sso/providers/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setRemoving(false);
      await refresh();
      onSaved(t('admin.signIn.removed', { name: provider?.displayName ?? '' }));
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setFailed(null);
    const problems = problemsOf(draft, isNew);
    setShown(problems);
    if (problems.length > 0) {
      // Focus goes to the first field with a problem (accessibility.md, forms).
      requestAnimationFrame(() =>
        form.querySelector<HTMLInputElement>(`[name="${problems[0] ?? ''}"]`)?.focus(),
      );
      return;
    }
    save.mutate();
  }

  const invalid = (p: Problem) => shown.includes(p);
  const inUse =
    provider === null
      ? null
      : provider.peopleCount === 0
        ? t('admin.signIn.notUsed')
        : provider.peopleCount === 1
          ? t('admin.signIn.inUseOne')
          : t('admin.signIn.inUse', { n: String(provider.peopleCount) });

  return (
    <CardSection
      title={isNew ? t('admin.signIn.newTitle') : provider.displayName}
      titleId={titleId}
      {...(inUse === null
        ? {}
        : {
            badge: (
              <StatusChip
                tone={provider !== null && provider.peopleCount > 0 ? 'success' : 'neutral'}
              >
                {inUse}
              </StatusChip>
            ),
          })}
    >
      {/* A safe form (ADR 0044): the client secret field is on the page before it hydrates. */}
      <SafeForm onSubmit={submit} validationBehavior="aria" className="flex flex-col gap-5">
        {failed !== null && <ErrorNotice title={failed} />}
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          {isNew ? (
            <TextField
              name="providerId"
              value={draft.providerId}
              onChange={set('providerId')}
              isInvalid={invalid('providerId')}
              isRequired
            >
              <Label>{t('admin.signIn.providerId')}</Label>
              <Input spellCheck={false} autoCapitalize="none" className="font-mono" />
              {invalid('providerId') ? (
                <FieldError>{t('admin.signIn.providerIdInvalid')}</FieldError>
              ) : (
                <Description>{t('admin.signIn.providerIdHelp')}</Description>
              )}
            </TextField>
          ) : (
            <Fixed
              label={t('admin.signIn.providerId')}
              value={provider.providerId}
              help={t('admin.signIn.fixedHelp')}
            />
          )}
          <TextField
            name="displayName"
            value={draft.displayName}
            onChange={set('displayName')}
            isInvalid={invalid('displayName')}
            isRequired
            maxLength={100}
          >
            <Label>{t('admin.signIn.displayName')}</Label>
            <Input />
            {invalid('displayName') ? (
              <FieldError>{t('admin.signIn.displayNameMissing')}</FieldError>
            ) : (
              <Description>
                {t('admin.signIn.displayNameHelp', {
                  name: draft.displayName.trim() === '' ? '...' : draft.displayName.trim(),
                })}
              </Description>
            )}
          </TextField>
          {isNew ? (
            <TextField
              name="issuer"
              type="url"
              value={draft.issuer}
              onChange={set('issuer')}
              isInvalid={invalid('issuer')}
              isRequired
            >
              <Label>{t('admin.signIn.issuer')}</Label>
              <Input placeholder="https://" spellCheck={false} />
              {invalid('issuer') && <FieldError>{t('admin.signIn.issuerInvalid')}</FieldError>}
            </TextField>
          ) : (
            <Fixed
              label={t('admin.signIn.issuer')}
              value={provider.issuer}
              help={t('admin.signIn.fixedHelp')}
            />
          )}
          {isNew ? (
            <TextField
              name="clientId"
              value={draft.clientId}
              onChange={set('clientId')}
              isInvalid={invalid('clientId')}
              isRequired
            >
              <Label>{t('admin.signIn.clientId')}</Label>
              <Input spellCheck={false} autoCapitalize="none" />
              {invalid('clientId') && <FieldError>{t('admin.signIn.clientIdMissing')}</FieldError>}
            </TextField>
          ) : (
            <Fixed
              label={t('admin.signIn.clientId')}
              value={provider.clientId ?? ''}
              help={t('admin.signIn.fixedHelp')}
            />
          )}
          <WriteOnlyField
            name="clientSecret"
            label={t('admin.signIn.clientSecret')}
            isSet={!isNew}
            value={draft.clientSecret}
            onChange={set('clientSecret')}
            isInvalid={invalid('clientSecret')}
            error={t('admin.signIn.clientSecretMissing')}
            isRequired={isNew}
          />
          <Domains domains={draft.allowedEmailDomains} onChange={set('allowedEmailDomains')} />
        </div>
        <div className="border-t border-separator">
          <CheckboxSetting
            label={t('admin.signIn.createAccounts')}
            description={t('admin.signIn.createAccountsHelp')}
            isSelected={draft.allowSignUp}
            onChange={set('allowSignUp')}
          />
        </div>
        {provider !== null && (
          <div className="pt-4">
            <CopyValue
              label={t('admin.signIn.redirectUri')}
              value={provider.redirectUri}
              help={t('admin.signIn.redirectUriHelp')}
            />
          </div>
        )}
        {isNew && (
          <p className="pt-4 text-small text-muted">{t('admin.signIn.redirectUriLater')}</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-separator pt-4">
          {provider === null ? (
            <span />
          ) : (
            <Button variant="ghost" className="lk-danger-text" onPress={() => setRemoving(true)}>
              {t('admin.signIn.remove')}
            </Button>
          )}
          <div className="flex gap-2">
            <Button
              variant="tertiary"
              onPress={() => {
                setFailed(null);
                setShown([]);
                if (isNew) onCancelNew?.();
                else setDraft(draftOf(provider));
              }}
            >
              {t('common.cancel')}
            </Button>
            <SubmitButton variant="primary" isPending={save.isPending}>
              {t('admin.signIn.save')}
            </SubmitButton>
          </div>
        </div>
      </SafeForm>
      {provider !== null && provider.onlyWayCount > 0 && (
        <TypedConfirmDialog
          isOpen={removing}
          onOpenChange={setRemoving}
          title={t('admin.signIn.removeTitle', { name: provider.displayName })}
          confirmLabel={t('admin.signIn.remove')}
          expected={provider.providerId}
          mismatch={t('admin.signIn.removeMismatch')}
          isPending={remove.isPending}
          onConfirm={() => remove.mutate(provider.providerId)}
        >
          {provider.onlyWayCount === 1
            ? t('admin.signIn.removeLockedOne', { id: provider.providerId })
            : t('admin.signIn.removeLocked', {
                n: String(provider.onlyWayCount),
                id: provider.providerId,
              })}
        </TypedConfirmDialog>
      )}
      {provider !== null && provider.onlyWayCount === 0 && (
        <ConfirmDialog
          isOpen={removing}
          onOpenChange={setRemoving}
          title={t('admin.signIn.removeTitle', { name: provider.displayName })}
          confirmLabel={t('admin.signIn.remove')}
          isPending={remove.isPending}
          onConfirm={() => remove.mutate(provider.providerId)}
        >
          {provider.peopleCount === 0
            ? t('admin.signIn.removeUnused')
            : t('admin.signIn.removePasswords')}
        </ConfirmDialog>
      )}
    </CardSection>
  );
}
