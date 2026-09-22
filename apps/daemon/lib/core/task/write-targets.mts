import { isAbsolute, relative, resolve } from 'node:path'
import type { TaskConfig } from './types.mts'

const MAX_WRITE_TARGETS = 128

/**
 * Resolve a task's deterministic write targets into bounded checkout-local
 * absolute paths. An omitted declaration returns undefined (observational);
 * a declared empty result returns an empty list as the repo-wide write-lock
 * marker.
 */
export function resolveTaskWritePaths(
  config: TaskConfig,
  input: unknown,
  workingDirectory: string,
): readonly string[] | undefined {
  if (!config.writeTargets) return undefined

  const raw = config.writeTargets(input)
  if (!Array.isArray(raw)) throw new Error('Task writeTargets must return an array')
  if (raw.length === 0) return []
  if (raw.length > MAX_WRITE_TARGETS) {
    throw new Error(`Task writeTargets exceeds ${MAX_WRITE_TARGETS} paths`)
  }

  const root = resolve(workingDirectory)
  const unique = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Task writeTargets must return non-empty path strings')
    }
    const absolute = resolve(root, value)
    const fromRoot = relative(root, absolute)
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
      throw new Error(`Task write target must be a file inside the active checkout: ${value}`)
    }
    unique.add(absolute)
  }
  return unique.size > 0 ? [...unique] : undefined
}
