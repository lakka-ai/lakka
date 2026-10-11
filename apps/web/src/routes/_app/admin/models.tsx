import { createFileRoute, redirect } from '@tanstack/react-router';
import { AdminTabsLayout } from '../../../components/admin/tabbed-page.tsx';

/*
 * Models and providers (Admin board), for instance admins; the api enforces it. Prices decide
 * what budgets are charged, so only instance admins see it. Two tabs, nested here: Models at
 * /admin/models and Model providers at /admin/models/providers (ADR 0100).
 */

export const Route = createFileRoute('/_app/admin/models')({
  beforeLoad: ({ context }) => {
    if (!context.me.isInstanceAdmin) throw redirect({ to: '/' });
  },
  component: () => <AdminTabsLayout page="models" />,
});
