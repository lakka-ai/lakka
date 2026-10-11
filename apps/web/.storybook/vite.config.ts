import tailwindcss from '@tailwindcss/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tailwind and React only: the stories need the app's styles, not its server.
export default defineConfig({
  plugins: [tailwindcss(), viteReact()],
});
