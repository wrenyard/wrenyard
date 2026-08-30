import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const petRoot = join(root, '..', 'pet');

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

await build({
  entryPoints: [join(root, 'src', 'preload.ts')],
  outfile: join(dist, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'external',
  external: ['electron'],
  logLevel: 'info',
});

await build({
  entryPoints: [join(root, 'src', 'update-helper-entry.ts')],
  outfile: join(dist, 'update-helper.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'external',
  logLevel: 'info',
});

const rendererDist = join(dist, 'renderer');
await mkdir(rendererDist, { recursive: true });
await build({
  entryPoints: [join(root, 'src', 'renderer', 'app.ts')],
  outfile: join(rendererDist, 'app.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome140',
  sourcemap: 'external',
  logLevel: 'info',
});
await Promise.all([
  copyFile(join(root, 'src', 'renderer', 'index.html'), join(rendererDist, 'index.html')),
  copyFile(join(root, 'src', 'renderer', 'app.css'), join(rendererDist, 'app.css')),
  copyFile(join(root, 'resources', 'icon-256.png'), join(rendererDist, 'icon-256.png')),
]);

// Pet is a Desktop-owned renderer module. Copy only its runtime assets into
// the Desktop bundle; there is no separately packaged Pet application.
const petRendererDist = join(dist, 'pet', 'renderer');
const petPreloadDist = join(dist, 'pet', 'preloads');
await Promise.all([
  mkdir(petRendererDist, { recursive: true }),
  mkdir(petPreloadDist, { recursive: true }),
]);
const petRendererFiles = [
  'house.html', 'house.js',
  'worker.html', 'worker.js',
  'entity.html', 'entity.js',
  'graph-slip.html', 'graph-slip.js',
  'transcript.html', 'transcript.js',
];
const petPreloadFiles = [
  'preload.js',
  'entity-preload.js',
  'graph-slip-preload.js',
  'transcript-preload.js',
];
await Promise.all([
  ...petRendererFiles.map((file) => copyFile(
    join(petRoot, 'dist', 'renderer', file),
    join(petRendererDist, file),
  )),
  ...petPreloadFiles.map((file) => copyFile(
    join(petRoot, 'dist', 'main', 'main', file),
    join(petPreloadDist, file),
  )),
]);
