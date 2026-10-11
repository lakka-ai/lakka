import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ModelProviders } from '../../../components/admin/model-providers.tsx';
import { providersQuery } from '../../../lib/queries.ts';

/*
 * Model provider keys for the whole server (PR-1, PR-2, PR-3, PR-8): the second tab of Models and
 * providers (ADR 0100).
 */

export const Route = createFileRoute('/_app/admin/models/providers')({
  loader: ({ context }) => context.queryClient.ensureQueryData(providersQuery(null)),
  component: ModelProvidersTab,
});

function ModelProvidersTab() {
  const { data: configs } = useSuspenseQuery(providersQuery(null));
  return <ModelProviders configs={configs} />;
}
