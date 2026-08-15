import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

// Clean only this package's dist output before rebuilding.
await rm(dist, { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(dist, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Matches the Node runtime bundled with the pinned Electron release.
  target: 'node22',
  sourcemap: 'external',
  // Keep the Electron API and DSH runtime/native package boundaries external;
  // they are resolved from the installed/asar node_modules at runtime.
  external: [
    'electron',
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@wrenyard/dsh-shell',
  ],
  logLevel: 'info',
});
