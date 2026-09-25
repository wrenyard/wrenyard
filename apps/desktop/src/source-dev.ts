import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Chinese display brand. Window/tray/dialog titles only — never a data directory name. */
export const PRODUCT_NAME = '啾啾工坊';
/**
 * Stable data identity of the installed Desktop package (`package.json` `name`).
 * Electron derives `app.getPath('userData')` from this when no explicit
 * `userData` override exists, so source-development must reuse the exact same
 * directory as the installed release. Keep it decoupled from PRODUCT_NAME,
 * which is localized display branding and must never name a data directory.
 */
export const DESKTOP_DATA_IDENTITY = '@wrenyard/desktop';
export const SOURCE_DEV_FLAG = '1';

export interface ElectronPathApp {
  setName(name: string): void;
  setPath(name: 'userData' | string, path: string): void;
  getPath(name: 'appData' | 'userData' | string): string;
}

export function isSourceDevelopment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WRENYARD_SOURCE_DEV === SOURCE_DEV_FLAG;
}

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WRENYARD_DEV_SUPERVISED === SOURCE_DEV_FLAG;
}

export function resolveSourceDesktopUserData(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  appData?: string,
): string {
  const override = env.WRENYARD_DESKTOP_USER_DATA?.trim();
  if (override) return resolve(override);
  if (platform === 'win32') {
    return join(appData ?? env.APPDATA ?? join(home, 'AppData', 'Roaming'), DESKTOP_DATA_IDENTITY);
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', DESKTOP_DATA_IDENTITY);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(home, '.config'), DESKTOP_DATA_IDENTITY);
}

/** Must run before app ready so the single-instance lock shares the installed identity. */
export function applySourceDevelopmentIdentity(
  app: ElectronPathApp,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isSourceDevelopment(env)) return undefined;
  app.setName(PRODUCT_NAME);
  const userData = resolveSourceDesktopUserData(env, platform, homedir(), app.getPath('appData'));
  app.setPath('userData', userData);
  return userData;
}
