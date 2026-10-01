// Shared dependency shape for the domain IPC registrars. Each registrar
// receives the live `ipcMain`, the shell window options it reads handlers
// from, a sender assertion, and the shell page setter for the navigate
// channel. Registrars are pure wiring: they register handlers and return a
// cleanup that removes exactly the channels they own.

import type { WebContents } from 'electron';
import type { ShellPage } from '../../shell-contract.js';
import type { ShellWindowOptions } from '../../shell-window.js';

export interface ShellIpcDeps {
  options: ShellWindowOptions;
  assertShellSender(sender: WebContents): void;
  setPage(page: ShellPage, focus?: boolean): void;
}
