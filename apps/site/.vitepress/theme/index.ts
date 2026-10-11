import type { Theme } from 'vitepress';
// The default theme without its bundled Inter, so the site loads only the app's own typefaces.
import DefaultTheme from 'vitepress/theme-without-fonts';

// The weights apps/web/src/styles/app.css imports, from the same OFL packages: bundled into the
// build, never fetched from a font service (ADR 0119).
import '@fontsource/atkinson-hyperlegible-next/400.css';
import '@fontsource/atkinson-hyperlegible-next/500.css';
import '@fontsource/atkinson-hyperlegible-next/600.css';
import '@fontsource/atkinson-hyperlegible-next/700.css';
import '@fontsource/atkinson-hyperlegible-mono/400.css';
import '@fontsource/atkinson-hyperlegible-mono/500.css';
import '@fontsource/newsreader/400.css';

// The design's own file, read in place, so the site and the app cannot drift apart.
import '../../../../docs/design/theme/lakka-theme.css';
import './custom.css';

export default DefaultTheme satisfies Theme;
