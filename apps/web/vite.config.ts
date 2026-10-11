import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the browser talks to this dev server, which forwards API paths to the api
// process. That mirrors Caddy in production, so web and api share one origin (ADR 0006).
const apiTarget = process.env['LAKKA_API_INTERNAL_URL'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/v1': apiTarget,
      '/healthz': apiTarget,
    },
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
