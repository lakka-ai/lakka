import { createContext, use, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Decorator, Preview } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
// The app's stylesheet and theme apply to every story; importing it is the point.
// oxlint-disable-next-line import/no-unassigned-import
import '../src/styles/app.css';

/*
 * Stories render with the app's stylesheet and theme. The theme toolbar sets the same `dark`
 * class the app's color-scheme script sets. Components that link with the router get a
 * memory router, so a link renders its real href and never leaves the story.
 */

const withTheme: Decorator = (Story, context) => {
  const dark = context.globals['theme'] === 'dark';
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return (
    <div className="min-h-screen bg-background p-4 text-sm text-foreground sm:p-6">
      <Story />
    </div>
  );
};

// One router for the gallery; the story it shows comes through context, so switching stories
// or changing args never builds a new router.
const CurrentStory = createContext<ReactNode>(null);
const router = createRouter({
  routeTree: createRootRoute({ component: () => use(CurrentStory) }),
  history: createMemoryHistory({ initialEntries: ['/'] }),
});

const withRouter: Decorator = (Story) => (
  <CurrentStory value={<Story />}>
    <RouterProvider router={router} />
  </CurrentStory>
);

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Color scheme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [withTheme, withRouter],
  parameters: {
    layout: 'fullscreen',
    // test/stories runs axe on every story; here the panel shows the same result while working.
    a11y: { test: 'error' },
  },
};

export default preview;
