// Navigation/chrome IPC: the page-navigation command. The title bar, menu and
// window-state channels are renderer-bound pushes (`notifyWindowStateChanged`,
// `viewChanged`) and have no main-side handler; `showAppMenu` is registered by
// the renderer preload only and appears here solely so its removal is owned
// alongside navigation. Handler semantics are unchanged from the original
// inline registration.

import type { IpcMain } from 'electron';
import { SHELL_CHANNELS, isShellPage } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

export function registerNavigationChromeIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { assertShellSender, setPage } = deps;

  ipcMain.handle(SHELL_CHANNELS.navigate, async (event, page: unknown) => {
    assertShellSender(event.sender);
    if (!isShellPage(page)) throw new Error('Unsupported shell page');
    setPage(page);
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.navigate,
      SHELL_CHANNELS.showAppMenu,
    ]) ipcMain.removeHandler(channel);
  };
}
