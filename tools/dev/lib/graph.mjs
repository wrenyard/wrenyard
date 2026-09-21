import { watch } from 'node:fs';
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
]);

const IGNORED_FILES = new Set([
  'instance.json',
]);

export const COMPONENTS = Object.freeze({
  renderer: 'renderer',
  desktopMain: 'desktop-main',
  desktopPreload: 'desktop-preload',
  pet: 'pet',
  daemon: 'daemon',
  cli: 'cli',
  runtime: 'runtime',
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
  // Go writes the runtime binary here; spawning it on Windows also emits
  // change events. Incremental rebuilds use `.dev-gen`, already ignored.
  // Do not ignore every `bin` segment: `services/foreman/bin` is source.
  if (posixPath === 'runtime/forge/bin' || posixPath.startsWith('runtime/forge/bin/')) return true;
  const base = segments[segments.length - 1];
  if (IGNORED_FILES.has(base)) return true;
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

  if (posixPath.startsWith('runtime/forge/')) {
    return [COMPONENTS.runtime];
  }

  if (posixPath.startsWith('apps/cli/')) {
    return [COMPONENTS.cli];
  }

  if (posixPath.startsWith('services/foreman/')) {
    return [COMPONENTS.daemon];
  }

  if (posixPath.startsWith('apps/pet/')) {
    return [COMPONENTS.pet];
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

/** Expand shared/pet changes to the Desktop consumers that copy or bundle them. */
export function expandDependents(components) {
  const next = new Set(components);
  if (next.has(COMPONENTS.shared)) {
    next.add(COMPONENTS.renderer);
    next.add(COMPONENTS.desktopMain);
    next.add(COMPONENTS.desktopPreload);
    next.add(COMPONENTS.daemon);
  }
  if (next.has(COMPONENTS.pet)) {
    next.add(COMPONENTS.desktopMain);
  }
  return [...next];
}

/**
 * Components that decide *how* the stack is served rather than what it serves.
 * A change here is not rebuilt by the ordinary source loop: `pnpm build`
 * produces those artifacts, and the supervisor reloads them by replacing
 * itself.
 */
const SIGNIFICANT_COMPONENTS = new Set([COMPONENTS.shared, COMPONENTS.pet]);

export function significantComponents(components) {
  return [...new Set(components)].filter((component) => SIGNIFICANT_COMPONENTS.has(component));
}

const WATCH_ROOTS = [
  'apps',
  'packages',
  'services',
  'runtime',
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
  let timer = null;
  let queued = new Map();
  let closed = false;

  function flush() {
    timer = null;
    if (queued.size === 0) return;
    const files = [...queued.keys()];
    const components = [...new Set(files.flatMap((file) => classifyPath(file)))];
    queued = new Map();
    if (components.length === 0 && files.length === 0) return;
    onChange({ files, components });
  }

  function note(relativePath, event) {
    if (closed) return;
    const normalized = relativePath.split('\\').join('/');
    if (shouldIgnore(normalized)) return;
    queued.set(normalized, event);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  for (const root of options.roots ?? WATCH_ROOTS) {
    const full = resolve(checkout, root);
    try {
      const watcher = watchImpl(full, { recursive: true }, (event, filename) => {
        const rel = filename
          ? relative(checkout, resolve(full, filename.toString())).split('\\').join('/')
          : root;
        note(rel, event);
      });
      watcher.on?.('error', () => {
        // Directory may vanish during rebuilds; ignore.
      });
      watchers.push(watcher);
    } catch {
      // Files like package.json use non-recursive file watches.
      try {
        const watcher = watchImpl(full, (event) => note(root, event));
        watchers.push(watcher);
      } catch {
        // Missing optional roots are skipped.
      }
    }
  }

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
