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
const exact = (name, range) => {
  const version = requireFromSession(`${name}/package.json`).version;
  if (!version) throw new Error(`cannot resolve ${name}@${range}`);
  return version;
};
const external = {
  'better-sqlite3': execution.dependencies['better-sqlite3'],
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
  external: [...Object.keys(external), '@deepseek-ai/*', '@wrenyard/dsh-shell'],
  logLevel: 'info',
});
await writeFile(join(dist, 'package.json'), `${JSON.stringify({
  name: '@wrenyard/daemon-bundle',
  private: true,
  type: 'module',
  dependencies: Object.fromEntries(Object.entries(external).map(([name, range]) => [name, name === 'better-sqlite3' ? range : exact(name, range)])),
}, null, 2)}\n`);
