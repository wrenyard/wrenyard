// Appearance and preference IPC: resolved appearance reads, the general settings snapshot, and the preferences snapshot /
// single-preference write. Handler semantics are unchanged from the original
// inline registrations.

import type { IpcMain } from 'electron';
import { SHELL_CHANNELS, isPreferenceId } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

export function registerAppearancePreferencesIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.appearanceSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.getAppearance();
  });
  ipcMain.handle(SHELL_CHANNELS.settingsSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.getSettings();
  });
  ipcMain.handle(SHELL_CHANNELS.preferencesSnapshot, async (event) => {
    assertShellSender(event.sender);
    return options.getPreferences();
  });
  ipcMain.handle(SHELL_CHANNELS.setPreference, async (event, id: unknown, value: unknown) => {
    assertShellSender(event.sender);
    if (!isPreferenceId(id)) throw new Error('未知偏好');
    return options.setPreference(id, value);
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.appearanceSnapshot,
      SHELL_CHANNELS.settingsSnapshot,
      SHELL_CHANNELS.preferencesSnapshot,
      SHELL_CHANNELS.setPreference,
    ]) ipcMain.removeHandler(channel);
  };
}
