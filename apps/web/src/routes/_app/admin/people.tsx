import { Button } from '@heroui/react';
import { createFileRoute, redirect, useNavigate, useSearch } from '@tanstack/react-router';
import { AdminTabsLayout } from '../../../components/admin/tabbed-page.tsx';
import { Icon } from '../../../components/icons.tsx';
import { t } from '../../../i18n/index.ts';

/*
 * People and sign-in (Admin board), for instance admins; the api enforces it. Two tabs, nested
 * here: People at /admin/people and Sign-in providers at /admin/people/sign-in (ADR 0100).
 * Add a provider sits in the page header on the Sign-in providers tab, and opens the new
 * provider's form there through the address (?new), so a reload keeps it open.
 */

export const Route = createFileRoute('/_app/admin/people')({
  beforeLoad: ({ context }) => {
    if (!context.me.isInstanceAdmin) throw redirect({ to: '/' });
  },
  component: PeopleAndSignIn,
});

function PeopleAndSignIn() {
  const navigate = useNavigate();
  // The Sign-in providers tab's validated search, or undefined when another tab is open.
  const signIn = useSearch({ from: '/_app/admin/people/sign-in', shouldThrow: false });
  const onSignIn = signIn !== undefined;
  const adding = signIn?.new === true;
  return (
    <AdminTabsLayout
      page="people"
      action={
        onSignIn &&
        !adding && (
          <Button
            size="lg"
            variant="primary"
            onPress={() =>
              void navigate({
                to: '/admin/people/sign-in',
                search: { new: true },
                resetScroll: false,
              })
            }
          >
            <Icon name="plus" />
            {t('admin.signIn.add')}
          </Button>
        )
      }
    />
  );
}
