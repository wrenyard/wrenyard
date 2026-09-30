import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { DESKTOP_PAGES, DESKTOP_PRELOADS } from './src/entries.ts';
import { devShellCsp } from './tools/vite-dev-csp.mjs';

// electron-vite 5.0.0's isolated-entry progress reporter assumes a TTY; piped builds (pack.mjs, CI) have none.
if (!process.stdout.isTTY) {
  Object.assign(process.stdout, { clearLine: () => true, cursorTo: () => true, moveCursor: () => true });
}

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, 'src');
const dist = resolve(here, 'dist');
const fromSrc = (entries: Record<string, string>) =>
  Object.fromEntries(Object.entries(entries).map(([id, file]) => [id, resolve(src, file)]));

export default defineConfig({
  main: {
    define: { __WRENYARD_DESKTOP_BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
    build: {
      outDir: resolve(dist, 'main'),
      emptyOutDir: true,
      externalizeDeps: false,
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve(src, 'main.ts') },
        output: { format: 'es' },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(dist, 'preload'),
      emptyOutDir: true,
      externalizeDeps: false,
      // Sandboxed preloads cannot require sibling chunks.
      isolatedEntries: true,
      sourcemap: true,
      rollupOptions: {
        input: fromSrc(DESKTOP_PRELOADS),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: src,
    base: './',
    publicDir: false,
    plugins: [react(), devShellCsp()],
    // Pre-bundle up front so a first page load never triggers a dependency re-optimization reload.
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime', 'pixi.js'] },
    server: { host: '127.0.0.1', port: 5199, strictPort: false },
    build: {
      outDir: resolve(dist, 'web'),
      emptyOutDir: true,
      sourcemap: true,
      modulePreload: { polyfill: false },
      rollupOptions: { input: fromSrc(DESKTOP_PAGES) },
    },
  },
});
