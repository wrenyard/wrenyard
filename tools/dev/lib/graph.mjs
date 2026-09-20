import { posix, sep, win32 } from 'node:path';

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
  const base = segments[segments.length - 1];
  if (IGNORED_FILES.has(base)) return true;
  if (base.endsWith('.log')) return true;
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

export function isRendererOnly(components) {
  const expanded = expandDependents(components);
  return expanded.length === 1 && expanded[0] === COMPONENTS.renderer;
}

export { win32 };
