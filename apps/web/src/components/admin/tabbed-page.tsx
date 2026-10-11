import type { ReactNode } from 'react';
import { Outlet, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { PageTabs } from '../patterns/tabs.tsx';
import { PageHeader } from '../patterns/page-header.tsx';

/*
 * The two Admin pages with two tabs each (Admin board): People and sign-in, and Models and
 * providers. A layout route draws the page's title, the open tab's intro, any action at the
 * right, and the tablist, once; each tab is a route nested under it, as Spend's Report and
 * Budgets and alerts are. The tablist stays mounted when the tab changes, so keyboard focus stays
 * on the tab (ADR 0100).
 */

type TabAddress =
  | '/admin/people'
  | '/admin/people/sign-in'
  | '/admin/models'
  | '/admin/models/providers';

interface Tab {
  to: TabAddress;
  label: MessageKey;
  intro: MessageKey;
}

const PAGES = {
  people: {
    title: 'admin.group.people',
    tabs: [
      { to: '/admin/people', label: 'admin.people.title', intro: 'admin.people.intro' },
      { to: '/admin/people/sign-in', label: 'admin.signIn.title', intro: 'admin.signIn.intro' },
    ],
  },
  models: {
    title: 'admin.group.models',
    tabs: [
      { to: '/admin/models', label: 'admin.models.title', intro: 'admin.models.intro' },
      {
        to: '/admin/models/providers',
        label: 'admin.providers.title',
        intro: 'admin.providers.intro',
      },
    ],
  },
} as const satisfies Record<string, { title: MessageKey; tabs: readonly [Tab, Tab] }>;

export function AdminTabsLayout({
  page,
  action,
}: {
  page: keyof typeof PAGES;
  /** At the right of the title for the open tab, such as Add a provider. */
  action?: ReactNode;
}) {
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const { title, tabs } = PAGES[page];
  // The first tab is the layout's own address, which every tab's address starts with.
  const open: Tab = matchRoute({ to: tabs[1].to }) === false ? tabs[0] : tabs[1];
  return (
    <>
      <PageHeader title={t(title)} lede={t(open.intro)} actions={action} />
      <PageTabs
        label={t(title)}
        selected={open.to}
        onSelectionChange={(id) => {
          const next = tabs.find((tab) => tab.to === id);
          if (next !== undefined) void navigate({ to: next.to });
        }}
        items={tabs.map((tab) => ({
          id: tab.to,
          label: t(tab.label),
          panel: (
            <div className="flex flex-col gap-6">
              <Outlet />
            </div>
          ),
        }))}
      />
    </>
  );
}
