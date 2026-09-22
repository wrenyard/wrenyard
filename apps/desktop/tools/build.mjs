import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const desktopBuildTime = new Date().toISOString();
const args = process.argv.slice(2);
const noClean = args.includes('--no-clean');
const onlyArg = args.find((arg) => arg.startsWith('--only='));
const only = new Set((onlyArg?.slice('--only='.length).split(',') ?? ['all']).filter(Boolean));
const buildAll = only.has('all');
const want = (target) => buildAll || only.has(target);

// Incremental source-dev builds must not delete an in-use dist tree.
if (!noClean) {
  await rm(dist, { recursive: true, force: true });
}

if (want('main')) {
  await build({
    entryPoints: [join(root, 'src', 'main.ts')],
    outfile: join(dist, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    // Bundled CommonJS dependencies still require Node built-ins at runtime.
    banner: { js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);" },
    // Matches the Node runtime bundled with the pinned Electron release.
    target: 'node22',
    sourcemap: 'external',
    define: {
      __WRENYARD_DESKTOP_BUILD_TIME__: JSON.stringify(desktopBuildTime),
    },
    // Keep the Electron API external; it is resolved from the installed
    // Electron runtime at run time.
    external: [
      'electron',
    ],
    logLevel: 'info',
  });
}

if (want('preload')) {
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
}

if (want('main') || want('preload')) {
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
}

if (want('renderer')) {
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
}

if (want('pet')) {
  // Pet is a Desktop-owned renderer module: its renderers, preloads and HTML
  // assets are built from this checkout in the same build graph as the rest of
  // Desktop. There is no separately packaged Pet application and no
  // cross-application dist copy.
  const petSrc = join(root, 'src', 'pet');
  const petRendererDist = join(dist, 'pet', 'renderer');
  const petPreloadDist = join(dist, 'pet', 'preloads');
  await Promise.all([
    mkdir(petRendererDist, { recursive: true }),
    mkdir(petPreloadDist, { recursive: true }),
  ]);

  // Renderer assets retired by an earlier Pet build must not survive an
  // incremental (--no-clean) Desktop build.
  await Promise.all(
    ['settings.html', 'settings.js', 'stats.html', 'stats.js', 'panel.css']
      .map((file) => rm(join(petRendererDist, file), { force: true })),
  );

  const petRenderers = [
    ['overlay/house/index.ts', 'house.js'],
    ['overlay/worker/index.ts', 'worker.js'],
    ['overlay/taskgraph-entity/index.ts', 'entity.js'],
    ['panels/transcript/index.ts', 'transcript.js'],
    ['panels/observatory/index.ts', 'graph-slip.js'],
  ];
  const petHtml = [
    ['overlay/house/index.html', 'house.html'],
    ['overlay/worker/index.html', 'worker.html'],
    ['overlay/taskgraph-entity/index.html', 'entity.html'],
    ['panels/transcript/index.html', 'transcript.html'],
    ['panels/observatory/index.html', 'graph-slip.html'],
  ];
  const petPreloads = [
    ['main/preload.ts', 'preload.js'],
    ['preloads/entity-preload.ts', 'entity-preload.js'],
    ['preloads/graph-slip-preload.ts', 'graph-slip-preload.js'],
    ['preloads/transcript-preload.ts', 'transcript-preload.js'],
  ];

  await Promise.all([
    ...petRenderers.map(([entry, outfile]) => build({
      entryPoints: [join(petSrc, entry)],
      outfile: join(petRendererDist, outfile),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'chrome140',
      logLevel: 'info',
    })),
    ...petPreloads.map(([entry, outfile]) => build({
      entryPoints: [join(petSrc, entry)],
      outfile: join(petPreloadDist, outfile),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      logLevel: 'info',
    })),
    ...petHtml.map(([entry, outfile]) => copyFile(
      join(petSrc, entry),
      join(petRendererDist, outfile),
    )),
  ]);
}
