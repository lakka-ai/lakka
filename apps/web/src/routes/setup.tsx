import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { SetupProvider } from '../components/public/setup.tsx';
import { setupStatusQuery } from '../lib/queries.ts';

/*
 * First-run setup (AD-1, ADR 0034, ADR 0098), in three steps at /setup/code,
 * /setup/recovery-key and /setup/account: prove access to the server with the setup code, save
 * the recovery key (the credential master key, shown only here; ADR 0021), then create the first
 * admin and workspace, which also signs them in. Once setup is done these pages send people to
 * sign-in.
 */

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupStatusQuery);
    if (!status.required) throw redirect({ to: '/sign-in' });
  },
  component: () => (
    <SetupProvider>
      <Outlet />
    </SetupProvider>
  ),
});
