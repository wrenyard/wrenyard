import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const FOREMAN_CONFIG_FILE_NAME = 'config.json'

export function resolveForemanConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const wrenyardConfigHome = env.WRENYARD_CONFIG_HOME?.trim()
  if (wrenyardConfigHome) return resolve(wrenyardConfigHome)
  return resolve(configRoot(env), 'wrenyard')
}

export function resolvePrimaryForemanConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(resolveForemanConfigDir(env), FOREMAN_CONFIG_FILE_NAME)
}

export function resolveDefaultForemanConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  // Legacy ~/.config/foreman is a read/migration fallback only: it is used
  // solely when the primary Wrenyard config is absent.
  const primary = resolvePrimaryForemanConfigPath(env)
  const legacy = resolve(configRoot(env), 'foreman', FOREMAN_CONFIG_FILE_NAME)
  return existsSync(legacy) && !existsSync(primary) ? legacy : primary
}

function configRoot(env: NodeJS.ProcessEnv): string {
  const xdgConfig = env.XDG_CONFIG_HOME?.trim()
  return xdgConfig ? resolve(xdgConfig) : join(homedir(), '.config')
}

export function resolveForemanConfigPath(
  value?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof value === 'string' && value.trim()) return resolve(value.trim())
  return resolveDefaultForemanConfigPath(env)
}

// Write-path resolution: an explicit config path stays authoritative, but an
// implicit write always targets the primary Wrenyard config directory — never
// the legacy Foreman read fallback.
export function resolveWriteForemanConfigPath(
  value?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof value === 'string' && value.trim()) return resolve(value.trim())
  return resolvePrimaryForemanConfigPath(env)
}
