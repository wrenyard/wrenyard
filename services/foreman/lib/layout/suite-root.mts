import { existsSync as defaultExistsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Root directory of the foreman package, derived from this module's location
 * (lib/layout two levels up -> services/foreman). This is the package SSOT for
 * package-private resources under both source and compiled/packaged layouts.
 */
export const foremanPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export interface ResolveWrenyardSuiteRootOptions {
  /** Package root from which to walk upward for suite markers. Defaults to foremanPackageRoot. */
  packageRoot?: string
  /** Environment to read WRENYARD_ROOT from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Filesystem existence probe; defaults to node:fs existsSync. */
  existsSync?: (path: string) => boolean
}

/**
 * Resolve the Wrenyard suite root (the git top-level containing the suite).
 * Precedence: a non-empty WRENYARD_ROOT that must exist and contain both suite
 * markers (pnpm-workspace.yaml and release-manifest.json); otherwise the
 * nearest ancestor of packageRoot (inclusive) containing both markers. Throws a
 * descriptive error when neither applies.
 */
export function resolveWrenyardSuiteRoot(options: ResolveWrenyardSuiteRootOptions = {}): string {
  const exists = options.existsSync ?? defaultExistsSync
  const env = options.env ?? process.env
  const packageRoot = options.packageRoot ?? foremanPackageRoot

  const explicitRoot = env.WRENYARD_ROOT?.trim()
  if (explicitRoot) {
    const normalized = resolve(explicitRoot)
    const missingMarkers = [
      'pnpm-workspace.yaml',
      'release-manifest.json',
    ].filter((marker) => !exists(join(normalized, marker)))
    if (missingMarkers.length > 0) {
      throw new Error(
        `WRENYARD_ROOT does not point at a valid Wrenyard suite root: ${normalized} is missing ${missingMarkers.join(' and ')}`,
      )
    }
    return realpathWhenPossible(normalized)
  }

  let current = resolve(packageRoot)
  while (true) {
    if (exists(join(current, 'pnpm-workspace.yaml')) && exists(join(current, 'release-manifest.json'))) {
      return realpathWhenPossible(current)
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  throw new Error(
    `Could not locate the Wrenyard suite root: no directory from ${resolve(packageRoot)} upward contains both pnpm-workspace.yaml and release-manifest.json`,
  )
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
