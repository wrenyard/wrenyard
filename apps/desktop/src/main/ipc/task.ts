// Task IPC: one read-only channel with its own method allowlist, mirroring the
// other domain registrars — assert the shell sender first, validate the method
// against TASK_METHODS, then delegate to the injected daemon request
// transport. Currently only `task.usage.liveList` is allowed: the batched
// cumulative live-usage read Desktop issues on open or reconnect.

import type { IpcMain } from 'electron';
import { SHELL_CHANNELS, TASK_METHODS } from '../../shell-contract.js';
import type { TaskMethod } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

/** Whether a renderer-supplied string is one of the allowed task methods. */
function isTaskMethod(value: unknown): value is TaskMethod {
  return typeof value === 'string' && (TASK_METHODS as readonly string[]).includes(value);
}

/** Registers the read-only `task` channel; `task.usage.liveList` is its only method. */
export function registerTaskIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.taskRequest, async (event, method: unknown, params: unknown) => {
    assertShellSender(event.sender);
    if (!isTaskMethod(method)) throw new Error(`不支持的任务方法：${String(method)}`);
    return options.request(method, params);
  });

  return () => {
    ipcMain.removeHandler(SHELL_CHANNELS.taskRequest);
  };
}
