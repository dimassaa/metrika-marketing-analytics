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
 */
export default defineConfig({
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: 'public/assets',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        dashboard: fileURLToPath(new URL('./client/entries/dashboard.jsx', import.meta.url)),
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
});
