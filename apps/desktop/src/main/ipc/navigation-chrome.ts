// Navigation/chrome IPC owns page navigation and the title-bar menu popup.

import type { IpcMain } from 'electron';
import { SHELL_CHANNELS, isShellPage } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

export function registerNavigationChromeIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  // Shell-scoped: only the shell window may switch the shared page or pop the
  // menu, so an open mini card can never alter the main window's chrome.
  const { assertShellWindowSender, setPage } = deps;

  ipcMain.handle(SHELL_CHANNELS.navigate, async (event, page: unknown) => {
    assertShellWindowSender(event.sender);
    if (!isShellPage(page)) throw new Error('Unsupported shell page');
    setPage(page);
  });

  ipcMain.handle(SHELL_CHANNELS.showAppMenu, (event, position: unknown) => {
    assertShellWindowSender(event.sender);
    if (position === undefined) return deps.showAppMenu();
    if (typeof position !== 'object' || position === null
      || !('x' in position) || typeof position.x !== 'number' || !Number.isFinite(position.x)
      || !('y' in position) || typeof position.y !== 'number' || !Number.isFinite(position.y)) {
      throw new Error('Invalid menu position');
    }
    deps.showAppMenu({ x: position.x, y: position.y });
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.navigate,
      SHELL_CHANNELS.showAppMenu,
    ]) ipcMain.removeHandler(channel);
  };
}
