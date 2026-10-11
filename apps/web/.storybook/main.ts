import { defineMain } from '@storybook/react-vite/node';

/*
 * The pattern gallery (docs/design/docs/patterns.md): every shared component with the sample
 * data from docs/design/docs/fixtures.md, in light and dark. Development only; it is not part
 * of the image.
 *
 * Nothing leaves the machine (invariant 8): telemetry, crash reports and update notices are
 * off here, and the scripts pass --no-version-updates.
 */
export default defineMain({
  framework: {
    name: '@storybook/react-vite',
    options: {
      // The app's own config runs TanStack Start, which only works inside the app.
      builder: { viteConfigPath: '.storybook/vite.config.ts' },
    },
  },
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  core: {
    disableTelemetry: true,
    enableCrashReports: false,
    disableWhatsNewNotifications: true,
    disableProjectJson: true,
  },
});
