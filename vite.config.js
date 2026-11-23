import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Bundles the React islands into `public/assets`.
 *
 * There is no dev server: Express renders every page and Vite only produces fingerprinted files. That keeps one
 * origin in the CSP and removes the dev/prod branch that a second origin would introduce.
 *
 * `publicDir: false` is required. With the default `public/`, Vite would copy the whole public tree into
 * `public/assets/` and produce the nested `public/assets/assets` directory; `app.css` and fonts are served by
 * Express from `public/` directly.
 *
 * The entry map is explicit rather than a glob so a scratch file cannot end up in the production bundle. Later
 * milestones add their page here together with the entry file.
 *
 * React's development/production branch is chosen twice. `.env` sets `NODE_ENV=development` for the Express
 * process, and Vite loads that file while resolving config, which would both define `process.env.NODE_ENV` and tell
 * `@vitejs/plugin-react` to emit `jsxDEV`. Pinning `define` alone is not enough: the production runtime has no
 * `jsxDEV` (`jsxDEV is not a function`), so the plugin's choice must be fixed too. `envDir: false` stops Vite reading
 * the Express `.env` at all (the client bundle has no `VITE_*` variables), `NODE_ENV` is derived from the mode, and
 * `define` states the same value explicitly. `vite build` therefore always ships production; `vite build --mode
 * development` is the explicit opt-out.
 */
export default defineConfig(({ mode }) => {
  const nodeEnv = mode === 'production' ? 'production' : 'development';
  process.env.NODE_ENV = nodeEnv;

  return {
    envDir: false,
    publicDir: false,
    plugins: [react()],
    define: {
      'process.env.NODE_ENV': JSON.stringify(nodeEnv),
    },
    build: {
      outDir: 'public/assets',
      emptyOutDir: true,
      manifest: true,
      sourcemap: false,
      rollupOptions: {
        input: {
          dashboard: fileURLToPath(new URL('./client/entries/dashboard.jsx', import.meta.url)),
          channels: fileURLToPath(new URL('./client/entries/channels.jsx', import.meta.url)),
          channel: fileURLToPath(new URL('./client/entries/channel.jsx', import.meta.url)),
          cohorts: fileURLToPath(new URL('./client/entries/cohorts.jsx', import.meta.url)),
          attribution: fileURLToPath(new URL('./client/entries/attribution.jsx', import.meta.url)),
          alerts: fileURLToPath(new URL('./client/entries/alerts.jsx', import.meta.url)),
          scenarios: fileURLToPath(new URL('./client/entries/scenarios.jsx', import.meta.url)),
        },
        output: {
          entryFileNames: '[name]-[hash].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          // Flat asset names: a nested `assets/` directory inside `public/assets` breaks the static mount and the
          // build-output regression test.
          assetFileNames: '[name]-[hash][extname]',
        },
      },
    },
  };
});
