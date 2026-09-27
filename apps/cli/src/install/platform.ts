/** Platform facts for the SEA install engine (spec section 5). */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PlatformTriplet } from '@wrenyard/protocol/update-feed';

/** Result of one external command, mirroring the relevant spawnSync fields. */
export interface CommandResult {
  status: number | null;
  error?: Error;
  stdout: string;
  stderr: string;
}

/** Injected process runner; the engine never spawns through a shell. */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string },
) => CommandResult | Promise<CommandResult>;

/** Static install layout names shared by the engine and its recovery scan. */
export const SUITE_VERSION_FILE = 'SUITE_VERSION';
export const DESKTOP_VERSION_FILE = 'desktop-version';
export const INSTALL_STATE_FILE = 'install-state.json';
export const INSTALL_LOCK_FILE = 'install.lock';
export const CURRENT_LINK = 'current';
export const DESKTOP_APP_NAME = '啾啾工坊.app';
export const DESKTOP_WINDOWS_DIR = 'Wrenyard Desktop';
export const DESKTOP_WINDOWS_EXE = 'wrenyard-desktop.exe';

/** True on Windows, where directories are linked with junctions. */
export function isWindows(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

/** Host triplet the release pipeline publishes, or null when unsupported. */
export function platformTriplet(
  platform: NodeJS.Platform,
  arch: string,
): PlatformTriplet | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

/** Default prefix: macOS `~/.local/share/wrenyard`, Windows `%LOCALAPPDATA%\wrenyard`. */
export function defaultPrefix(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const override = env.WRENYARD_PREFIX;
  if (typeof override === 'string' && override.length > 0) return override;
  if (isWindows(platform)) {
    const localAppData = env.LOCALAPPDATA ?? env.USERPROFILE ?? homedir();
    return join(localAppData, 'wrenyard');
  }
  const home = env.HOME ?? homedir();
  return join(home, '.local', 'share', 'wrenyard');
}

/** Default launcher directory: macOS `~/.local/bin`, Windows `<prefix>\bin`. */
export function defaultBinDir(prefix: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (isWindows(platform)) return join(prefix, 'bin');
  const home = env.HOME ?? homedir();
  return join(home, '.local', 'bin');
}

export function suiteExecutableName(platform: NodeJS.Platform): string {
  return isWindows(platform) ? 'wrenyard.exe' : 'wrenyard';
}

export function launcherFileName(platform: NodeJS.Platform): string {
  return isWindows(platform) ? 'wrenyard.cmd' : 'wrenyard';
}

export function windowsLauncherContent(prefix: string): string {
  return `@echo off\r\n"${join(prefix, CURRENT_LINK, 'wrenyard.exe')}" %*\r\n`;
}

export function desktopAppDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (isWindows(platform)) {
    const localAppData = env.LOCALAPPDATA ?? env.USERPROFILE ?? homedir();
    return join(localAppData, 'Programs', DESKTOP_WINDOWS_DIR);
  }
  const home = env.HOME ?? homedir();
  return join(home, 'Applications', DESKTOP_APP_NAME);
}

export function desktopAppExe(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (isWindows(platform)) return join(desktopAppDir(env, platform), DESKTOP_WINDOWS_EXE);
  return join(desktopAppDir(env, platform), 'Contents', 'MacOS', '啾啾工坊');
}

export function desktopParentDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return join(desktopAppDir(env, platform), '..');
}

export function startMenuShortcutPath(env: NodeJS.ProcessEnv): string {
  const appData = env.APPDATA ?? join(env.USERPROFILE ?? homedir(), 'AppData', 'Roaming');
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${'啾啾工坊'}.lnk`);
}

/** Desktop running probe: `pgrep -f` on macOS, `tasklist` on Windows. */
export function desktopRunningProbe(
  platform: NodeJS.Platform,
): { command: string; args: string[]; image: string } {
  if (isWindows(platform)) {
    return {
      command: 'tasklist',
      args: ['/FI', 'IMAGENAME eq wrenyard-desktop.exe'],
      image: DESKTOP_WINDOWS_EXE,
    };
  }
  return {
    command: 'pgrep',
    args: ['-f', '啾啾工坊\\.app/Contents/MacOS/'],
    image: '啾啾工坊',
  };
}

export function desktopProbeIsRunning(
  platform: NodeJS.Platform,
  result: CommandResult,
): boolean {
  if (result.error !== undefined) return false;
  if (isWindows(platform)) {
    return result.stdout.toLowerCase().includes(DESKTOP_WINDOWS_EXE.toLowerCase());
  }
  return result.status === 0;
}

export const MACOS_LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export const MACOS_DITTO = '/usr/bin/ditto';

/** Resolves the Windows `tar.exe` path without assuming a POSIX shell. */
export function windowsTarPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'tar.exe');
}
