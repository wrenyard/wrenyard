import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, watch } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';

const DEBOUNCE_MS = 300;

const IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.artifacts',
  'logs',
  'release',
  '.dev-gen',
  '.wrenyard',
  'test',
  'tests',
  '__tests__',
]);

const IGNORED_FILES = new Set([
  'instance.json',
]);

export const COMPONENTS = Object.freeze({
  renderer: 'renderer',
  desktopMain: 'desktop-main',
  desktopPreload: 'desktop-preload',
  daemon: 'daemon',
  cli: 'cli',
  shared: 'shared',
  supervisor: 'supervisor',
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
  if (IGNORED_FILES.has(base)) return true;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(base)) return true;
  if (base.endsWith('.tsbuildinfo')) return true;
  if (base.endsWith('.log') || base.endsWith('.exe')) return true;
  return false;
}

/**
 * Map a checkout-relative path to affected components.
 * Conservative: shared packages rebuild every consumer that bundles or copies them.
 */
export function classifyPath(relativePath) {
  const posixPath = toPosix(relativePath);
  if (shouldIgnore(posixPath)) return [];

  if (
    posixPath === 'package.json'
    || posixPath === 'pnpm-lock.yaml'
    || posixPath === 'pnpm-workspace.yaml'
    || posixPath.endsWith('/package.json')
  ) {
    return [COMPONENTS.manifest];
  }

  if (
    posixPath.startsWith('tools/dev/')
    || posixPath === 'tools/dev'
  ) {
    return [COMPONENTS.supervisor];
  }

  if (posixPath.startsWith('apps/cli/')) {
    return [COMPONENTS.cli];
  }

  if (posixPath.startsWith('apps/daemon/')) {
    return [COMPONENTS.daemon];
  }

  if (posixPath.startsWith('packages/')) {
    return [COMPONENTS.shared];
  }

  if (posixPath.startsWith('apps/desktop/src/renderer/') || posixPath === 'apps/desktop/src/renderer') {
    return [COMPONENTS.renderer];
  }
  if (posixPath === 'apps/desktop/src/preload.ts') {
    return [COMPONENTS.desktopPreload];
  }
  // Pet is a Desktop-owned module (`apps/desktop/src/pet`); any change under
  // `apps/desktop/src` rebuilds the Desktop main bundle, which produces the
  // in-tree Pet resources itself.
  if (posixPath.startsWith('apps/desktop/src/') || posixPath.startsWith('apps/desktop/resources/')) {
    if (posixPath.endsWith('preload.ts')) return [COMPONENTS.desktopPreload];
    return [COMPONENTS.desktopMain];
  }
  if (posixPath.startsWith('apps/desktop/tools/')) {
    return [COMPONENTS.supervisor];
  }

  return [];
}

export function classifyPaths(relativePaths) {
  const affected = new Set();
  for (const relativePath of relativePaths) {
    for (const component of classifyPath(relativePath)) {
      affected.add(component);
    }
  }
  return [...affected];
}

/** Expand shared changes to the Desktop and daemon consumers that bundle them. */
export function expandDependents(components) {
  const next = new Set(components);
  if (next.has(COMPONENTS.shared)) {
    next.add(COMPONENTS.renderer);
    next.add(COMPONENTS.desktopMain);
    next.add(COMPONENTS.desktopPreload);
    next.add(COMPONENTS.daemon);
  }
  return [...next];
}

/**
 * Components that decide *how* the stack is served rather than what it serves.
 * A change here is not rebuilt by the ordinary source loop: `pnpm build`
 * produces those artifacts, and the supervisor reloads them by replacing
 * itself.
 */
const SIGNIFICANT_COMPONENTS = new Set([COMPONENTS.shared]);

export function significantComponents(components) {
  return [...new Set(components)].filter((component) => SIGNIFICANT_COMPONENTS.has(component));
}

const WATCH_ROOTS = [
  'apps',
  'packages',
  'tools/dev',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

export function createWatcher(options) {
  const checkout = options.checkout;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const watchImpl = options.watch ?? watch;
  const onChange = options.onChange;
  const watchers = [];
  const roots = options.roots ?? WATCH_ROOTS;
  let timer = null;
  let closed = false;
  let snapshot = new Map();

  // Notifications can describe reads, directory metadata, or identical writes.
  // Cache content hashes by write metadata so our own reads do not create an
  // endless read/notification loop on Windows. Only content changes are applied.
  function scan() {
    const next = new Map();
    function preserve(path) {
      for (const [file, entry] of snapshot) {
        if (file === path || file.startsWith(`${path}/`)) next.set(file, entry);
      }
    }
    function visit(path) {
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
        if (previous?.stamp === stamp) {
          next.set(path, previous);
          return;
        }
        const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
        next.set(path, { stamp, hash });
      } catch (error) {
        // A missing path is a deletion; a temporarily unreadable path is not.
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') preserve(path);
      }
    }
    for (const root of roots) visit(root);
    return next;
  }

  function flush() {
    timer = null;
    if (closed) return;
    const next = scan();
    const files = [...new Set([...snapshot.keys(), ...next.keys()])]
      .filter((file) => snapshot.get(file)?.hash !== next.get(file)?.hash);
    snapshot = next;
    if (files.length === 0) return;
    const components = [...new Set(files.flatMap((file) => classifyPath(file)))];
    onChange({ files, components });
  }

  function note(relativePath) {
    if (closed) return;
    const normalized = relativePath.split('\\').join('/');
    if (shouldIgnore(normalized)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  for (const root of roots) {
    const full = resolve(checkout, root);
    try {
      const directory = lstatSync(full).isDirectory();
      const watcher = watchImpl(full, { recursive: directory }, (_event, filename) => {
        const rel = directory && filename
          ? relative(checkout, resolve(full, filename.toString())).split('\\').join('/')
          : root;
        note(rel);
      });
      watcher.on?.('error', () => {
        // Directory may vanish during rebuilds; ignore.
      });
      watchers.push(watcher);
    } catch {
      // Files like package.json use non-recursive file watches.
      try {
        const watcher = watchImpl(full, () => note(root));
        watchers.push(watcher);
      } catch {
        // Missing optional roots are skipped.
      }
    }
  }

  // Install watches first so edits during the initial scan still get queued.
  snapshot = scan();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }
    },
  };
}
