import { existsSync as defaultExistsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Root directory of the Wrenyard daemon package, derived from this module's
 * location (lib/layout two levels up -> apps/daemon). This is the package SSOT
 * for package-private resources under both source and compiled/packaged
 * layouts.
 */
export const foremanPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Marker that identifies a Wrenyard suite root. Both the source checkout and
 * the installed suite root contain exactly one contracts/versions.json, so it
 * is the single marker used for upward discovery.
 */
export const SUITE_ROOT_MARKER = 'contracts/versions.json'

export interface ResolveWrenyardSuiteRootOptions {
  /** Package root from which to walk upward for the suite root marker. Defaults to foremanPackageRoot. */
  packageRoot?: string
  /** Environment to read WRENYARD_ROOT from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Filesystem existence probe; defaults to node:fs existsSync. */
  existsSync?: (path: string) => boolean
}

/**
 * Resolve the Wrenyard suite root (the git top-level containing the suite).
 * Precedence: a non-empty WRENYARD_ROOT that must exist and contain the suite
 * root marker (contracts/versions.json); otherwise the nearest ancestor of
 * packageRoot (inclusive) containing that marker. Throws a descriptive error
 * when neither applies.
 */
export function resolveWrenyardSuiteRoot(options: ResolveWrenyardSuiteRootOptions = {}): string {
  const exists = options.existsSync ?? defaultExistsSync
  const env = options.env ?? process.env
  const packageRoot = options.packageRoot ?? foremanPackageRoot

  const explicitRoot = env.WRENYARD_ROOT?.trim()
  if (explicitRoot) {
    const normalized = resolve(explicitRoot)
    if (!exists(join(normalized, SUITE_ROOT_MARKER))) {
      throw new Error(
        `WRENYARD_ROOT does not point at a valid Wrenyard suite root: ${normalized} is missing ${SUITE_ROOT_MARKER}`,
      )
    }
    return realpathWhenPossible(normalized)
  }

  let current = resolve(packageRoot)
  while (true) {
    if (exists(join(current, SUITE_ROOT_MARKER))) {
      return realpathWhenPossible(current)
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  throw new Error(
    `Could not locate the Wrenyard suite root: no directory from ${resolve(packageRoot)} upward contains ${SUITE_ROOT_MARKER}`,
  )
}

/**
 * Read the version of the suite rooted at `root`. The SUITE_VERSION marker,
 * written by the release build into installed suites, takes precedence; the
 * suite's package.json version is the fallback, and '0.0.0' is returned when
 * neither is readable.
 */
export function readSuiteVersion(root: string): string {
  try {
    const marker = readFileSync(join(root, 'SUITE_VERSION'), 'utf8').trim()
    if (marker) return marker
  } catch {
    // Fall through to the package manifest.
  }
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof manifest.version === 'string' && manifest.version.trim()) return manifest.version
  } catch {
    // Fall through to the default.
  }
  return '0.0.0'
}

/**
 * Resolve the installed package root for packageName relative to packageRoot
 * without assuming node_modules layout or requiring a package.json subpath to
 * be exported. Resolve the public package entry, then walk upward to the
 * nearest package.json whose declared name matches the request.
 */
export function resolveDependencyPackageRoot(packageRoot: string, packageName: string): string {
  const requireFromPackage = createRequire(join(packageRoot, 'package.json'))
  const entry = requireFromPackage.resolve(packageName)
  let current = dirname(entry)
  while (true) {
    const manifestPath = join(current, 'package.json')
    if (defaultExistsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
        if (manifest.name === packageName) return realpathWhenPossible(current)
      } catch {
        // Keep walking: a malformed or unrelated ancestor is not the requested package root.
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`resolved '${packageName}' entry '${entry}' has no matching package root`)
}

function realpathWhenPossible(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
