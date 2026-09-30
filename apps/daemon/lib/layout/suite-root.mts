import { existsSync as defaultExistsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Set by the daemon and CLI bundle builds to the suite root relative to the
 * bundle file: `..` for `<suite>/daemon/daemon.mjs`, `.` for `<suite>/wrenyard[.exe]`.
 */
declare const __WRENYARD_BUNDLE_SUITE_ROOT__: string | undefined

const moduleDir = dirname(fileURLToPath(import.meta.url))

/** True when running from a daemon or CLI bundle instead of the source tree. */
export const runningFromBundle = typeof __WRENYARD_BUNDLE_SUITE_ROOT__ === 'string'

/** Suite root: the installed `resources/wrenyard` tree, or the checkout root from source. */
export const bundledSuiteRoot = resolve(moduleDir, runningFromBundle ? __WRENYARD_BUNDLE_SUITE_ROOT__! : '../../../..')

/**
 * Root directory of the Wrenyard daemon package (`apps/daemon` from source).
 * A bundle has no package tree, so it reports the suite root.
 */
export const foremanPackageRoot = runningFromBundle ? bundledSuiteRoot : resolve(moduleDir, '../..')

/**
 * Marker that identifies a Wrenyard suite root. Both the source checkout and
 * the installed suite root contain exactly one contracts/versions.json, so it
 * is the single marker used for upward discovery.
 */
export const SUITE_ROOT_MARKER = 'contracts/versions.json'

export interface ResolveWrenyardSuiteRootOptions {
  /** Suite root to validate; defaults to the one derived from this module's location. */
  suiteRoot?: string
  /** Filesystem existence probe; defaults to node:fs existsSync. */
  existsSync?: (path: string) => boolean
}

/** The suite root derived from the running layout, validated by its contracts/versions.json marker. */
export function resolveWrenyardSuiteRoot(options: ResolveWrenyardSuiteRootOptions = {}): string {
  const exists = options.existsSync ?? defaultExistsSync
  const root = resolve(options.suiteRoot ?? bundledSuiteRoot)
  if (!exists(join(root, SUITE_ROOT_MARKER))) {
    throw new Error(`Could not locate the Wrenyard suite root: ${root} is missing ${SUITE_ROOT_MARKER}`)
  }
  return realpathWhenPossible(root)
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

function realpathWhenPossible(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
