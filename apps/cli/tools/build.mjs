import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/wrenyard.mjs',
  banner: { js: '#!/usr/bin/env node' },
});

// SEA entry: bundled CommonJS for the standalone single-file executable.
await build({
  entryPoints: ['src/sea-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/wrenyard-sea.cjs',
  sourcemap: false,
});
