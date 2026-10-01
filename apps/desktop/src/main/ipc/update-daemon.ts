// Update/daemon-adjacent IPC and the remaining shell settings utilities: the
// update snapshot/check/install surface, pet-settings and workspace saves, and
// the settings-file / logs-directory / reveal-workspace helpers. The daemon
// lifecycle channels (`daemonSnapshot`/`daemonStart`/`daemonRestart`) are
// registered directly in `main.ts`, not here. Handler semantics are unchanged
// from the original inline registrations.

import type { IpcMain } from 'electron';
import { SHELL_CHANNELS, type PetCompanionSettings } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

export function registerUpdateDaemonIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.updateSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.getUpdate();
  });
  ipcMain.handle(SHELL_CHANNELS.checkUpdate, async (event) => {
    assertShellSender(event.sender);
    return options.checkUpdate();
  });
  ipcMain.handle(SHELL_CHANNELS.requestInstall, async (event) => {
    assertShellSender(event.sender);
    return options.requestInstall();
  });
  ipcMain.handle(SHELL_CHANNELS.savePetSettings, async (event, settings: PetCompanionSettings) => {
    assertShellSender(event.sender);
    return options.savePetSettings(settings);
  });
  ipcMain.handle(SHELL_CHANNELS.saveWorkspace, async (event, path: unknown, create: unknown) => {
    assertShellSender(event.sender);
    if (typeof path !== 'string' || path.length > 4_096) throw new Error('Workspace 路径无效');
    if (create !== undefined && create !== null && typeof create !== 'boolean') throw new Error('Workspace 创建参数无效');
    return options.saveWorkspace(path, create === true);
  });
  ipcMain.handle(SHELL_CHANNELS.openSettingsFile, async (event) => {
    assertShellSender(event.sender);
    return options.openSettingsFile();
  });
  ipcMain.handle(SHELL_CHANNELS.openLogsDirectory, async (event) => {
    assertShellSender(event.sender);
    return options.openLogsDirectory();
  });
  ipcMain.handle(SHELL_CHANNELS.revealWorkspace, async (event, path: unknown) => {
    assertShellSender(event.sender);
    if (typeof path !== 'string' || path.length === 0 || path.length > 4_096) throw new Error('工作区路径无效');
    return options.revealWorkspace(path);
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.updateSnapshot,
      SHELL_CHANNELS.checkUpdate,
      SHELL_CHANNELS.requestInstall,
      SHELL_CHANNELS.savePetSettings,
      SHELL_CHANNELS.saveWorkspace,
      SHELL_CHANNELS.openSettingsFile,
      SHELL_CHANNELS.openLogsDirectory,
      SHELL_CHANNELS.revealWorkspace,
    ]) ipcMain.removeHandler(channel);
  };
}
