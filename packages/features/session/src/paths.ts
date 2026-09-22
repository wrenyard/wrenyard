import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the DSH runtime by package resolution, so the feature works both from
 * the monorepo source layout and from a deployed tree where `@wrenyard/session`
 * sits under a nested `node_modules`. Nothing here depends on Electron: the DSH
 * child is always started with the real Node executable (see `dsh-process.ts`).
 */
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function packageDir(specifier: string): string | undefined {
  try {
    return dirname(require.resolve(`${specifier}/package.json`));
  } catch {
    return undefined;
  }
}

/** Walk up from `startDir` looking for a relative path. */
function findUp(startDir: string, relative: string): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Absolute path to `@deepseek-ai/dsh/lib/bin.js`. */
export function resolveDshBin(): string {
  const dshDir = packageDir('@deepseek-ai/dsh');
  if (dshDir) {
    const bin = join(dshDir, 'lib', 'bin.js');
    if (existsSync(bin)) return bin;
    try {
      return require.resolve('@deepseek-ai/dsh');
    } catch {
      // Fall through to the nested deployed layout.
    }
  }
  const nested = findUp(here, join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  if (nested) return nested;
  throw new Error('@deepseek-ai/dsh is not resolvable from @wrenyard/session');
}

/** Runtime version for the existing product About surface. */
export function resolveDshVersion(): string {
  try {
    const value = require('@deepseek-ai/dsh/package.json') as { version?: unknown };
    return typeof value.version === 'string' ? value.version : 'unknown';
  } catch { return 'unknown'; }
}

/**
 * Directory of the managed `@wrenyard/dsh-shell` bundle that is copied into the
 * isolated DSH profile. Resolved from node_modules first, then from the
 * monorepo source layout.
 */
export function resolveShellSource(): string {
  const installed = packageDir('@wrenyard/dsh-shell');
  if (installed) return installed;
  const nested = findUp(here, join('node_modules', '@wrenyard', 'dsh-shell'));
  if (nested) return nested;
  const source = resolve(here, '..', '..', '..', 'dsh-shell');
  if (existsSync(source)) return source;
  throw new Error('@wrenyard/dsh-shell source not found');
}

/**
 * Directory that contains the `@deepseek-ai` scope the DSH profile links as its
 * runtime modules. Absent when DSH is not installed beside this package, in
 * which case the profile simply keeps its own resolution.
 */
export function resolveRuntimeModulesDir(): string | undefined {
  // Use this feature's direct composition dependencies, not DSH's private
  // pnpm dependency snapshot (which need not contain the configured plugins).
  const dependency = findUp(here, join('node_modules', '@deepseek-ai', 'dsh'));
  return dependency ? dirname(dirname(dependency)) : undefined;
}
