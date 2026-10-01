// Appearance and preference IPC: resolved appearance reads, the general settings snapshot, and the preferences snapshot /
// single-preference write. Handler semantics are unchanged from the original
// inline registrations.

import type { IpcMain, WebContents } from 'electron';
import { SHELL_CHANNELS, isPreferenceId } from '../../shell-contract.js';
import { isRegisteredPetSender } from '../../pet/main/controller.js';
import type { ShellIpcDeps } from './deps.js';

export function registerAppearancePreferencesIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  // Only the appearance read admits an owned Pet window, which mirrors the
  // shared theme; settings, preferences and writes stay shell-only.
  const assertShellOrPetSender = (sender: WebContents): void => {
    if (isRegisteredPetSender(sender)) return;
    assertShellSender(sender);
  };

  ipcMain.handle(SHELL_CHANNELS.appearanceSnapshot, async (event) => {
    assertShellOrPetSender(event.sender);
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
