import { resolve } from 'node:path'
import { resolveWrenyardConfigRoot } from './paths.ts'

export const WRENYARD_CONFIG_FILE_NAME = 'config.json'

export function resolvePrimaryWrenyardConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(resolveWrenyardConfigRoot(env), WRENYARD_CONFIG_FILE_NAME)
}

export function resolveDefaultWrenyardConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePrimaryWrenyardConfigPath(env)
}

export function resolveWrenyardConfigPath(
  value?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof value === 'string' && value.trim()) return resolve(value.trim())
  return resolveDefaultWrenyardConfigPath(env)
}

// Write-path resolution: read and write choose the same current Wrenyard
// config path.
export function resolveWriteWrenyardConfigPath(
  value?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveWrenyardConfigPath(value, env)
}
