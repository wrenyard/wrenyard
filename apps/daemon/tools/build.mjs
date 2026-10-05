import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundles the daemon into dist/daemon.mjs. Only native modules and the DSH
// runtime (spawned as its own program and loaded from disk) stay external;
// dist/package.json lists them with exact versions for packaging.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');
const dist = join(root, 'dist');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

const session = await readJson(join(repo, 'packages', 'features', 'session', 'package.json'));
const execution = await readJson(join(repo, 'packages', 'execution', 'package.json'));
const requireFromSession = createRequire(join(repo, 'packages', 'features', 'session', 'package.json'));
// A package may not export ./package.json (sharp does not), so the manifest is
// found by walking up from the resolved entry instead of requiring the subpath.
const exact = async (name, range) => {
  let dir = dirname(requireFromSession.resolve(name));
  while (dir !== dirname(dir)) {
    const manifest = await readJson(join(dir, 'package.json')).catch(() => undefined);
    if (manifest?.name === name && manifest.version) return manifest.version;
    dir = dirname(dir);
  }
  throw new Error(`cannot resolve ${name}@${range}`);
};
const external = {
  'better-sqlite3': execution.dependencies['better-sqlite3'],
  // sharp is a native module: it must stay external and be installed from the
  // daemon bundle manifest, where its version is pinned to the resolved install.
  ...(session.dependencies.sharp ? { sharp: session.dependencies.sharp } : {}),
  ...Object.fromEntries(Object.entries(session.dependencies).filter(([name]) => name.startsWith('@deepseek-ai/'))),
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [join(root, 'lib', 'main.mts')],
  outfile: join(dist, 'daemon.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: 'external',
  // Bundled CommonJS dependencies still require Node built-ins at runtime.
  banner: { js: "import { createRequire as __wrenyardCreateRequire } from 'node:module'; const require = __wrenyardCreateRequire(import.meta.url);" },
  define: { __WRENYARD_BUNDLE_SUITE_ROOT__: JSON.stringify('..') },
  external: [...Object.keys(external), '@deepseek-ai/*'],
  logLevel: 'info',
});
await writeFile(join(dist, 'package.json'), `${JSON.stringify({
  name: '@wrenyard/daemon-bundle',
  private: true,
  type: 'module',
  dependencies: Object.fromEntries(await Promise.all(Object.entries(external).map(async ([name, range]) => [name, name === 'better-sqlite3' ? range : await exact(name, range)]))),
}, null, 2)}\n`);
