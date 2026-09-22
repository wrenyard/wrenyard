import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Stable data identity of the installed Desktop package (`package.json`
 * `name`). Electron derives `app.getPath('userData')` from this when no
 * explicit `userData` override exists, so the daemon must reuse the exact same
 * directory as the installed Desktop release — including when the daemon is
 * started from the CLI and no Electron process exists. It is deliberately
 * decoupled from the localized display brand, which never names a data
 * directory.
 */
const DESKTOP_DATA_IDENTITY = '@wrenyard/desktop'

/**
 * Resolve the Desktop `userData` root that owns session/DSH state.
 *
 * `WRENYARD_DESKTOP_USER_DATA` wins on every platform; otherwise the platform
 * default mirrors Electron: Windows `%APPDATA%/@wrenyard/desktop`, macOS
 * `~/Library/Application Support/@wrenyard/desktop`, Linux
 * `($XDG_CONFIG_HOME or ~/.config)/@wrenyard/desktop`.
 *
 * There is no fallback to any daemon-owned state directory and no directory
 * scanning: a missing root is an ordinary path that will simply be created by
 * the session feature on first use.
 */
export function resolveDesktopStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.WRENYARD_DESKTOP_USER_DATA?.trim()
  if (override) return resolve(override)

  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    return join(appData, DESKTOP_DATA_IDENTITY)
  }

  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', DESKTOP_DATA_IDENTITY)
  }

  const xdg = env.XDG_CONFIG_HOME?.trim()
  return join(xdg ? resolve(xdg) : join(home, '.config'), DESKTOP_DATA_IDENTITY)
}
