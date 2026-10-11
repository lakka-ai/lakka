import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { PeopleList } from '../../../components/admin/people.tsx';
import { usersQuery } from '../../../lib/queries.ts';

/* People (ID-3, ID-6, NF-P4, ADR 0097): the first tab of People and sign-in (ADR 0100). */

export const Route = createFileRoute('/_app/admin/people/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(usersQuery),
  component: PeopleTab,
});

function PeopleTab() {
  const { me } = Route.useRouteContext();
  const { data: people } = useSuspenseQuery(usersQuery);
  return <PeopleList people={people} me={me.actingUserId} />;
}
