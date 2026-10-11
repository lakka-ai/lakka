import type { ReactNode } from 'react';
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
  useMatches,
  useRouter,
} from '@tanstack/react-router';
import { SourceNotice } from '../components/shell/source-notice.tsx';
import { t } from '../i18n/index.ts';
import { getAbout } from '../lib/about.ts';
import { COLOR_SCHEME_SCRIPT } from '../lib/color-scheme.ts';
import { NONCE_META } from '../router.tsx';
import type { RouterContext } from '../router.tsx';
import appCss from '../styles/app.css?url';

/*
 * The document shell. Every page carries the AGPL source notice for network users (AD-6), with
 * a link read when the page is served (ADR 0085). The head carries this response's script
 * nonce, so the browser's router renders the same one the server did.
 */

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: t('app.name') },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  loader: () => getAbout(),
  // What the deployment is does not change while a page is open.
  staleTime: Infinity,
  component: RootComponent,
  notFoundComponent: NotFound,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-3xl p-8">
      <h1 className="lk-title">{t('app.notFound')}</h1>
    </main>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  const { sourceUrl } = Route.useLoaderData();
  const nonce = useRouter().options.ssr?.nonce;
  // The signed-in shell places the source link itself, in the account menu (ADR 0107). Every
  // other page, including ones added later, gets the notice here.
  const signedIn = useMatches({ select: (matches) => matches.some((m) => m.routeId === '/_app') });
  return (
    // The color-scheme script adds a class to <html> before React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        {nonce !== undefined && <meta name={NONCE_META} content={nonce} />}
        <ScriptOnce>{COLOR_SCHEME_SCRIPT}</ScriptOnce>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <a href="#main" className="lk-skip-link">
          {t('app.skipToContent')}
        </a>
        {signedIn ? (
          children
        ) : (
          <div className="flex min-h-screen flex-col">
            <div className="flex-1">{children}</div>
            <SourceNotice sourceUrl={sourceUrl} />
          </div>
        )}
        <Scripts />
      </body>
    </html>
  );
}
