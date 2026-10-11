import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Catalogue, CustomModels, PriceUpdates } from '../../../components/admin/models.tsx';
import { catalogueFeedQuery, modelsQuery, providersQuery } from '../../../lib/queries.ts';

/*
 * The model catalogue, models an instance admin added by hand, and price updates (PR-5, PR-6,
 * PR-7): the first tab of Models and providers (ADR 0100).
 */

export const Route = createFileRoute('/_app/admin/models/')({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(modelsQuery),
      context.queryClient.ensureQueryData(providersQuery(null)),
      context.queryClient.ensureQueryData(catalogueFeedQuery),
    ]),
  component: ModelsTab,
});

function ModelsTab() {
  const { data: models } = useSuspenseQuery(modelsQuery);
  const { data: providers } = useSuspenseQuery(providersQuery(null));
  const { data: feed } = useSuspenseQuery(catalogueFeedQuery);
  return (
    <>
      <Catalogue models={models.filter((m) => m.source === 'catalogue')} providers={providers} />
      <CustomModels models={models.filter((m) => m.source === 'custom')} />
      <PriceUpdates feed={feed} />
    </>
  );
}
