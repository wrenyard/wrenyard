import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, watch } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';

const DEBOUNCE_MS = 300;

const IGNORED_SEGMENTS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.artifacts', 'logs', 'release',
  '.dev-gen', '.wrenyard', 'test', 'tests', '__tests__',
]);

const WATCH_ROOTS = ['apps', 'packages', 'tools/dev', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

/**
 * Change categories. Only `shared`, `daemon` and the `desktop-*` targets drive a
 * build and restart; the rest only print a notice (section 4.3).
 */
export const COMPONENTS = Object.freeze({
  shared: 'shared',
  daemon: 'daemon',
  desktopRenderer: 'desktop-renderer',
  desktopMain: 'desktop-main',
  desktopPreload: 'desktop-preload',
  cli: 'cli',
  tooling: 'tooling',
  manifest: 'manifest',
});

function toPosix(relativePath) {
  return relativePath.split(sep).join(posix.sep).replace(/^(\.\/)+/u, '');
}

export function shouldIgnore(relativePath) {
  const posixPath = toPosix(relativePath);
  if (!posixPath || posixPath === '.') return true;
  const segments = posixPath.split('/');
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return true;
  const base = segments[segments.length - 1];
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(base)
    || base.endsWith('.tsbuildinfo')
    || base.endsWith('.log')
    || base.endsWith('.exe');
}

function isManifest(posixPath) {
  return posixPath === 'package.json'
    || posixPath === 'pnpm-lock.yaml'
    || posixPath === 'pnpm-workspace.yaml'
    || posixPath.endsWith('/package.json');
}

/** Map a checkout-relative path to the components it affects (section 4.3). */
export function classifyPath(relativePath) {
  const posixPath = toPosix(relativePath);
  if (shouldIgnore(posixPath)) return [];
  if (isManifest(posixPath)) return [COMPONENTS.manifest];
  if (posixPath === 'tools/dev' || posixPath.startsWith('tools/dev/')) return [COMPONENTS.tooling];
  if (posixPath.startsWith('apps/desktop/tools/')) return [COMPONENTS.tooling];
  if (posixPath.startsWith('apps/cli/')) return [COMPONENTS.cli];
  if (posixPath.startsWith('apps/daemon/')) return [COMPONENTS.daemon];
  if (posixPath.startsWith('packages/')) return [COMPONENTS.shared];
  if (posixPath.startsWith('apps/desktop/src/renderer/') || posixPath === 'apps/desktop/src/renderer') return [COMPONENTS.desktopRenderer];
  if (posixPath.startsWith('apps/desktop/src/') || posixPath.startsWith('apps/desktop/resources/')) {
    return posixPath.endsWith('preload.ts') ? [COMPONENTS.desktopPreload] : [COMPONENTS.desktopMain];
  }
  return [];
}

export function classifyChanges(relativePaths) {
  const components = new Set();
  for (const relativePath of relativePaths) for (const component of classifyPath(relativePath)) components.add(component);
  return [...components];
}

/**
 * Content-hash watcher. Notifications can describe reads, directory metadata or
 * identical writes, so only a changed hash counts as a change; this also keeps
 * our own reads from creating a read/notification loop on Windows.
 */
export function createWatcher({ checkout, onChange }) {
  const watchers = [];
  let timer = null;
  let closed = false;
  let snapshot = new Map();

  function scan() {
    const next = new Map();
    const preserve = (path) => {
      for (const [file, entry] of snapshot) if (file === path || file.startsWith(`${path}/`)) next.set(file, entry);
    };
    const visit = (path) => {
      if (shouldIgnore(path)) return;
      const full = resolve(checkout, path);
      try {
        const stat = lstatSync(full, { bigint: true });
        if (stat.isDirectory()) {
          for (const name of readdirSync(full)) visit(`${path}/${name}`);
          return;
        }
        // Do not traverse symlinks into dependencies or outside the checkout.
        if (!stat.isFile() || classifyPath(path).length === 0) return;
        const stamp = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
        const previous = snapshot.get(path);
        if (previous?.stamp === stamp) { next.set(path, previous); return; }
        next.set(path, { stamp, hash: createHash('sha256').update(readFileSync(full)).digest('hex') });
      } catch (error) {
        // A missing path is a deletion; a temporarily unreadable path is not.
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') preserve(path);
      }
    };
    for (const root of WATCH_ROOTS) visit(root);
    return next;
  }

  function flush() {
    timer = null;
    if (closed) return;
    const next = scan();
    const files = [...new Set([...snapshot.keys(), ...next.keys()])].filter((file) => snapshot.get(file)?.hash !== next.get(file)?.hash);
    snapshot = next;
    if (files.length > 0) onChange({ files, components: classifyChanges(files) });
  }

  function note(relativePath) {
    if (closed) return;
    if (shouldIgnore(relativePath.split('\\').join('/'))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  for (const root of WATCH_ROOTS) {
    const full = resolve(checkout, root);
    try {
      const directory = lstatSync(full).isDirectory();
      const watcher = watch(full, { recursive: directory }, (_event, filename) => {
        const rel = directory && filename ? relative(checkout, resolve(full, filename.toString())).split('\\').join('/') : root;
        note(rel);
      });
      watcher.on?.('error', () => { /* Directory may vanish during rebuilds; ignore. */ });
      watchers.push(watcher);
    } catch {
      try { watchers.push(watch(full, () => note(root))); } catch { /* Missing optional roots are skipped. */ }
    }
  }

  // Install watches first so edits during the initial scan still get queued.
  snapshot = scan();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) { try { watcher.close(); } catch { /* ignore */ } }
    },
  };
}
