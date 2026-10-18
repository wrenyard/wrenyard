/**
 * Linux XDG autostart for the packaged AppImage. Electron's login-item API
 * would write `process.execPath` (the FUSE mount) which disappears on exit;
 * this writes `$APPIMAGE` into `~/.config/autostart`.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isFuseMountPath, resolveAppImagePath } from './updater/apply-linux.js';

const DESKTOP_FILE_NAME = 'wrenyard-desktop.desktop';

export function linuxAutostartPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return join(configHome, 'autostart', DESKTOP_FILE_NAME);
}

export function resolveLinuxAutostartExec(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string | null {
  const appImage = resolveAppImagePath(env);
  if (appImage) return appImage;
  if (isFuseMountPath(execPath, env)) return null;
  return execPath;
}

/**
 * Quote a single Exec argument per the Desktop Entry spec: always wrap in
 * double quotes, then escape `\`, `"`, `` ` `` and `$` inside the quotes.
 * Double remaining backslashes so GKeyFile unescape still yields those
 * Exec escapes. Paths with CR/LF are refused; `$APPIMAGE` is used, not the
 * FUSE mount.
 */
function quoteDesktopExec(filePath: string): string {
  if (filePath === '' || /[\n\r]/.test(filePath)) {
    throw new Error('开机启动路径无效');
  }
  const execEscaped = filePath
    .replace(/%/g, '%%')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
  return `"${execEscaped}"`.replace(/\\/g, '\\\\');
}

export function readLinuxOpenAtLogin(env: NodeJS.ProcessEnv = process.env, home?: string): boolean {
  return existsSync(linuxAutostartPath(env, home));
}

export function setLinuxOpenAtLogin(
  enabled: boolean,
  options: { env?: NodeJS.ProcessEnv; execPath?: string; home?: string } = {},
): void {
  const env = options.env ?? process.env;
  const filePath = linuxAutostartPath(env, options.home);
  if (!enabled) {
    rmSync(filePath, { force: true });
    return;
  }
  const exec = resolveLinuxAutostartExec(env, options.execPath);
  if (!exec) throw new Error('无法在 AppImage 挂载点内写入开机启动项');
  if (isFuseMountPath(filePath, env) || isFuseMountPath(dirname(filePath), env)) {
    throw new Error('无法在 AppImage 挂载点内写入开机启动项');
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=啾啾工坊',
    `Exec=${quoteDesktopExec(resolve(exec))}`,
    'StartupWMClass=wrenyard-desktop',
    'MimeType=x-scheme-handler/wrenyard;',
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    '',
  ].join('\n'));
}
