import { isAbsolute, relative, resolve } from 'node:path'
import type { TaskConfig } from './types.ts'

const MAX_WRITE_TARGETS = 128

/**
 * Resolve a task's deterministic write targets into bounded checkout-local
 * absolute paths. An omitted declaration returns undefined (observational, no
 * lock). A declared empty result is an empty list (no lock). Use `'.'` for
 * repository-wide scope under the active checkout.
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
    const trimmed = value.trim()
    const absolute = trimmed === '.' ? root : resolve(root, value)
    if (trimmed !== '.') {
      const fromRoot = relative(root, absolute)
      const parentPrefix = `..${process.platform === 'win32' ? '\\' : '/'}`
      if (fromRoot === '..' || fromRoot.startsWith(parentPrefix) || isAbsolute(fromRoot)) {
        throw new Error(`Task write target must be a file inside the active checkout: ${value}`)
      }
    }
    unique.add(absolute)
  }
  return [...unique]
}
