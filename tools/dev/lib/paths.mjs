import { homedir as osHomedir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_DATA_IDENTITY = '@wrenyard/desktop';
const WINDOWS_BUSINESS_PIPE = '\\\\.\\pipe\\wrenyard';
const POSIX_BUSINESS_SOCK = '/tmp/wrenyard.sock';

/** Wrenyard state root; the daemon resolves the same path from the same env. */
export function stateRoot(env = process.env, home = osHomedir()) {
  const override = env.WRENYARD_STATE_HOME?.trim();
  if (override) return resolve(override);
  const xdg = env.XDG_STATE_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(home, '.local', 'state'), 'wrenyard');
}

export function configDir(env = process.env, home = osHomedir()) {
  const override = env.WRENYARD_CONFIG_HOME?.trim();
  if (override) return resolve(override);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(home, '.config'), 'wrenyard');
}

export function devDir(root) {
  return join(root, 'dev');
}

export function logDir(root) {
  return join(devDir(root), 'logs');
}

export function devLockPath(root) {
  return join(devDir(root), 'dev.lock');
}

/** Written by the daemon itself (`apps/daemon/lib/daemon/instance-lock.mts`). */
export function daemonLockPath(root) {
  return join(root, 'daemon.lock');
}

export function businessIpcPath(platform = process.platform, env = process.env) {
  for (const candidate of [env.WRENYARD_IPC_PATH, env.FOREMAN_IPC_PATH, env.FOREMAN_PET_FOREMAN_IPC]) {
    const path = candidate?.trim();
    if (path) return path;
  }
  return platform === 'win32' ? WINDOWS_BUSINESS_PIPE : POSIX_BUSINESS_SOCK;
}

/** Installed Desktop `userData`, matching the identity Electron derives from `@wrenyard/desktop`. */
export function desktopUserData(platform = process.platform, env = process.env, home = osHomedir()) {
  const override = env.WRENYARD_DESKTOP_USER_DATA?.trim();
  if (override) return resolve(override);
  if (platform === 'win32') return join(env.APPDATA?.trim() || join(home, 'AppData', 'Roaming'), DESKTOP_DATA_IDENTITY);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', DESKTOP_DATA_IDENTITY);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(home, '.config'), DESKTOP_DATA_IDENTITY);
}
