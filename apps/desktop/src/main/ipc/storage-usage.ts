// Read-only storage-usage IPC: the `storage.usage` snapshot behind the Settings
// "存储" page. The daemon owns the scan (and reports the device it runs on) and
// its request transport is injected as a dependency, so this bridge only
// forwards the refresh flag. Daemon errors reject the invoke: nothing is
// swallowed and no fallback/zero snapshot is fabricated here.

import type { IpcMain } from 'electron';
import { SHELL_CHANNELS, type StorageUsageSnapshot } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

export function registerStorageUsageIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { request } = deps.options;

  ipcMain.handle(SHELL_CHANNELS.storageUsage, (_event, refresh) =>
    request('storage.usage', { refresh: refresh === true }) as Promise<StorageUsageSnapshot>);

  return () => ipcMain.removeHandler(SHELL_CHANNELS.storageUsage);
}
