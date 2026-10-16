// Workspace-todo IPC: one channel forwarding an allowlisted set of `todo.*`
// daemon methods. Handler semantics mirror the other domain registrars: assert
// the shell sender first, validate the bounded method, then delegate to the
// injected daemon request transport. Desktop never reads a todo file; it only
// transports the call, and a daemon error rejects the invoke unchanged.

import type { IpcMain } from 'electron';
import { TODO_METHODS, SHELL_CHANNELS } from '../../shell-contract.js';
import type { TodoMethod } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

/** Whether a renderer-supplied string is one of the four allowed todo methods. */
function isTodoMethod(value: unknown): value is TodoMethod {
  return typeof value === 'string' && (TODO_METHODS as readonly string[]).includes(value);
}

export function registerTodoIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.todoRequest, async (event, method: unknown, params: unknown) => {
    assertShellSender(event.sender);
    if (!isTodoMethod(method)) throw new Error(`不支持的待办方法：${String(method)}`);
    return options.request(method, params);
  });

  return () => {
    ipcMain.removeHandler(SHELL_CHANNELS.todoRequest);
  };
}
