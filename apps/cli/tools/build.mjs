import { build } from 'esbuild';

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
