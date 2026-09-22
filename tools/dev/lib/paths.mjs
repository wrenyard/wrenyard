import { existsSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join, resolve, sep, win32, posix } from 'node:path';

const DESKTOP_DATA_IDENTITY = '@wrenyard/desktop';
const WINDOWS_DEV_PIPE = '\\\\.\\pipe\\wrenyard-dev';
const WINDOWS_BUSINESS_PIPE = '\\\\.\\pipe\\wrenyard';
const POSIX_BUSINESS_SOCK = '/tmp/wrenyard.sock';

/**
 * @param {string} value
 * @param {{ platform?: NodeJS.Platform, realpath?: (path: string) => string, exists?: (path: string) => boolean }} [options]
 */
export function normalizeCheckout(value, options = {}) {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  let resolved = resolve(value);
  if (exists(resolved) && typeof options.realpath === 'function') {
    try {
      resolved = options.realpath(resolved);
    } catch {
      // Keep the resolved path when the realpath probe fails.
    }
  }
  if (platform === 'win32') {
    return win32.normalize(resolved).replace(/[/\\]+$/u, '').toLowerCase();
  }
  return posix.normalize(resolved).replace(/\/+$/u, '') || '/';
}

/** Compare two checkouts with Windows case/alias folding. */
export function sameCheckout(left, right, platform = process.platform, options = {}) {
  return normalizeCheckout(left, { ...options, platform }) === normalizeCheckout(right, { ...options, platform });
}

/** True when `child` is `parent` or a path under it. */
export function pathInside(child, parent, platform = process.platform, options = {}) {
  if (!child || !parent) return false;
  const left = normalizeCheckout(child, { ...options, platform });
  const right = normalizeCheckout(parent, { ...options, platform });
  if (left === right) return true;
  const glue = platform === 'win32' ? '\\' : '/';
  const prefix = right.endsWith(glue) ? right : `${right}${glue}`;
  return left.startsWith(prefix);
}

export function stateRoot(env = process.env, home = osHomedir()) {
  const wrenyardStateHome = env.WRENYARD_STATE_HOME?.trim();
  if (wrenyardStateHome) return resolve(wrenyardStateHome);
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  const stateHome = xdgStateHome ? resolve(xdgStateHome) : join(home, '.local', 'state');
  return join(stateHome, 'wrenyard');
}

export function configDir(env = process.env, home = osHomedir()) {
  const wrenyardConfigHome = env.WRENYARD_CONFIG_HOME?.trim();
  if (wrenyardConfigHome) return resolve(wrenyardConfigHome);
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  return join(xdgConfig ? resolve(xdgConfig) : join(home, '.config'), 'wrenyard');
}

export function devDir(root) {
  return join(root, 'dev');
}

export function instancePath(root) {
  return join(devDir(root), 'instance.json');
}

export function logDir(root) {
  return join(devDir(root), 'logs');
}

export function controlEndpoint(platform = process.platform, root) {
  if (platform === 'win32') return WINDOWS_DEV_PIPE;
  return join(devDir(root), 'control.sock');
}

export function businessIpcPath(platform = process.platform, env = process.env) {
  for (const candidate of [env.WRENYARD_IPC_PATH, env.FOREMAN_IPC_PATH, env.FOREMAN_PET_FOREMAN_IPC]) {
    const path = candidate?.trim();
    if (path) return path;
  }
  return platform === 'win32' ? WINDOWS_BUSINESS_PIPE : POSIX_BUSINESS_SOCK;
}

/**
 * Installed Desktop `userData` directory. Mirrors the identity Electron derives
 * from the packaged `package.json` `name` (`@wrenyard/desktop`), not the
 * localized display brand, so supervisor records and the source Electron child
 * agree with the installed release.
 */
export function desktopUserData(platform = process.platform, env = process.env, home = osHomedir()) {
  const override = env.WRENYARD_DESKTOP_USER_DATA?.trim();
  if (override) return resolve(override);
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming');
    return join(appData, DESKTOP_DATA_IDENTITY);
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', DESKTOP_DATA_IDENTITY);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(home, '.config'), DESKTOP_DATA_IDENTITY);
}

export { sep };
