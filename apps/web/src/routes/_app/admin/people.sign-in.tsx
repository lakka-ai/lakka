import { useEffect, useState } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ProviderForm } from '../../../components/admin/sign-in.tsx';
import { EmptyList } from '../../../components/patterns/card-section.tsx';
import { t } from '../../../i18n/index.ts';
import { ssoProvidersQuery } from '../../../lib/queries.ts';

/*
 * Sign-in providers (ID-2, AD-1, ADR 0032, ADR 0097): the second tab of People and sign-in
 * (ADR 0100). `?new` opens the form for a new provider; Add a provider, in the page header, sets
 * it.
 */

export const Route = createFileRoute('/_app/admin/people/sign-in')({
  validateSearch: (search: Record<string, unknown>): { new?: true } =>
    search['new'] === true || search['new'] === 'true' ? { new: true } : {},
  loader: ({ context }) => context.queryClient.ensureQueryData(ssoProvidersQuery),
  component: SignInTab,
});

function SignInTab() {
  const { data: providers } = useSuspenseQuery(ssoProvidersQuery);
  const adding = Route.useSearch().new === true;
  const navigate = Route.useNavigate();
  const [status, setStatus] = useState('');
  const closeNew = () => void navigate({ search: {}, resetScroll: false });
  // Starting a new provider clears what the last save said.
  useEffect(() => {
    if (adding) setStatus('');
  }, [adding]);
  return (
    <>
      <p role="status" className="sr-only">
        {status}
      </p>
      {adding && (
        <ProviderForm
          provider={null}
          onCancelNew={closeNew}
          onSaved={(message) => {
            closeNew();
            setStatus(message);
          }}
        />
      )}
      {providers.length === 0 && !adding && <EmptyList>{t('admin.signIn.none')}</EmptyList>}
      {providers.map((p) => (
        <ProviderForm key={p.providerId} provider={p} onSaved={setStatus} />
      ))}
    </>
  );
}
