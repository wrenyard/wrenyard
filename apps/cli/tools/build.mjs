import { build } from 'esbuild';

// SEA entry: the complete CLI as one CommonJS bundle. The executable sits at the
// suite root, so module-relative paths resolve from process.execPath (`__filename`
// in a SEA). Native modules and the daemon itself are never loaded by the CLI:
// `daemon run` starts the bundled daemon with the suite's Node runtime.
await build({
  entryPoints: ['src/index.mts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: 'dist/wrenyard-sea.cjs',
  sourcemap: false,
  banner: { js: "const __wrenyardImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: {
    'import.meta.url': '__wrenyardImportMetaUrl',
    __WRENYARD_BUNDLE_SUITE_ROOT__: JSON.stringify('.'),
  },
  external: ['@wrenyard/daemon/bootstrap', 'better-sqlite3', '@deepseek-ai/*'],
  logLevel: 'info',
});
