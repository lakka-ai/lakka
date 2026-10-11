import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { createIsomorphicFn, getGlobalStartContext } from '@tanstack/react-start';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { routeTree } from './routeTree.gen.ts';

export interface RouterContext {
  queryClient: QueryClient;
}

/** The meta tag the document carries its nonce in, for the browser's router to render the same. */
export const NONCE_META = 'lakka-csp-nonce';

/**
 * This response's script nonce (ADR 0085): from the request context on the server, and on the
 * client from the document it rendered, so hydration writes the same attributes.
 */
const cspNonce = createIsomorphicFn()
  .server((): string | undefined => {
    const context: unknown = getGlobalStartContext();
    return context !== null &&
      typeof context === 'object' &&
      'cspNonce' in context &&
      typeof context.cspNonce === 'string'
      ? context.cspNonce
      : undefined;
  })
  .client(
    (): string | undefined =>
      document.querySelector<HTMLMetaElement>(`meta[name="${NONCE_META}"]`)?.content || undefined,
  );

const CHAT_PAGE = /^\/workspaces\/[^/]+\/chat\/?$/;

export function getRouter() {
  const nonce = cspNonce();
  // One client per router, and so per request during SSR: a shared client could leak one
  // person's data into another person's page.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    // Not on the chat page, which shows each conversation from its end and follows it there
    // (ADR 0105). The router would otherwise put back the thread's position, and carry one
    // conversation's position over to the next, after the page went to the end.
    scrollRestoration: ({ location }) => !CHAT_PAGE.test(location.pathname),
    defaultPreload: 'intent',
    ssr: nonce === undefined ? {} : { nonce },
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
  interface StaticDataRouteOption {
    /** The page fills the space beside the side menu, with its own main and phone top bar. */
    fullPage?: boolean;
  }
}
