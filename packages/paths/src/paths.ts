import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Shared WRENYARD directory resolution.
 *
 * These are the single source of truth for the Wrenyard config and state roots
 * used by the daemon, desktop, and every client package. An explicit
 * WRENYARD_CONFIG_HOME / WRENYARD_STATE_HOME (when non-blank, after trimming)
 * names a private application root and is resolved as-is; otherwise the
 * conventional `~/.config/wrenyard` and `~/.local/state/wrenyard` roots are
 * used. There are no XDG/CODEX/CLAUDE fallbacks and no filesystem side effects.
 */
export function resolveWrenyardConfigRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  joinFn: typeof join = join,
): string {
  const override = env.WRENYARD_CONFIG_HOME?.trim()
  if (override) return resolve(override)
  return joinFn(home, '.config', 'wrenyard')
}

export function resolveWrenyardStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  joinFn: typeof join = join,
): string {
  const override = env.WRENYARD_STATE_HOME?.trim()
  if (override) return resolve(override)
  return joinFn(home, '.local', 'state', 'wrenyard')
}

/** Private per-client state directory: `<state root>/clients/<parts...>`. */
export function resolveWrenyardClientStateDir(env: NodeJS.ProcessEnv, ...parts: string[]): string {
  return join(resolveWrenyardStateRoot(env), 'clients', ...parts)
}

/** Unified diagnostic log directory: `<state root>/logs`. */
export function resolveWrenyardLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveWrenyardStateRoot(env), 'logs')
}

/** Electron Desktop data directory: `<state root>/desktop`. */
export function resolveWrenyardDesktopDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveWrenyardStateRoot(env), 'desktop')
}
