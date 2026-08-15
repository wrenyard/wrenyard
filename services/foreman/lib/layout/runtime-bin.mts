import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveWrenyardSuiteRoot } from './suite-root.mts'

export interface ResolveRuntimeBinOptions {
  /** Wrenyard suite root to search for a contained native runtime. */
  suiteRoot?: string
  /** Filesystem existence probe; defaults to node:fs existsSync. */
  existsSync?: (path: string) => boolean
  /** Target platform, used to pick the native binary name; defaults to process.platform. */
  platform?: NodeJS.Platform
}

/**
 * Resolve the Wrenyard runtime binary. Resolution order:
 *  1. non-empty WRENYARD_RUNTIME_BIN;
 *  2. the first existing suite-contained native runtime candidate for the
 *     platform (`<suite>/.wrenyard/runtime/forge[.exe]` for the packed CLI,
 *     `<suite>/bin/forge[.exe]` for the suite zip, and
 *     `<suite>/runtime/forge/bin/forge[.exe]` for a source checkout);
 *  3. non-empty legacy FOREMAN_FORGE_BIN;
 *  4. `forge` on PATH.
 * If suite-root discovery fails, resolution continues to the legacy fallbacks.
 */
export function resolveRuntimeBin(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveRuntimeBinOptions = {},
): string {
  const runtimeBin = env.WRENYARD_RUNTIME_BIN?.trim()
  if (runtimeBin) return runtimeBin

  const exists = options.existsSync ?? existsSync
  const platform = options.platform ?? process.platform
  const binaryName = platform === 'win32' ? 'forge.exe' : 'forge'

  const suiteRoot = options.suiteRoot ?? discoverSuiteRoot()
  if (suiteRoot) {
    const candidates = [
      join(suiteRoot, '.wrenyard', 'runtime', binaryName),
      join(suiteRoot, 'bin', binaryName),
      join(suiteRoot, 'runtime', 'forge', 'bin', binaryName),
    ]
    const found = candidates.find((candidate) => exists(candidate))
    if (found) return found
  }

  const legacyBin = env.FOREMAN_FORGE_BIN?.trim()
  if (legacyBin) return legacyBin

  return 'forge'
}

function discoverSuiteRoot(): string | undefined {
  try {
    return resolveWrenyardSuiteRoot()
  } catch {
    // Suite-root discovery is best-effort; fall through to legacy resolution.
    return undefined
  }
}
