// Workspace-todo IPC: user todo operations and the separate bot-todo channel
// have independent method allowlists. Registrars mirror the other
// domain handlers: assert the shell sender first, validate the method against
// that channel's allowlist, then delegate to the injected daemon request
// transport. Desktop never reads a todo file; a daemon error rejects the invoke
// unchanged.

import type { IpcMain } from 'electron';
import { BOT_TODO_METHODS, TODO_METHODS, SHELL_CHANNELS } from '../../shell-contract.js';
import type { BotTodoMethod, TodoMethod } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

/** Whether a renderer-supplied string is an allowed Desktop todo method. */
function isTodoMethod(value: unknown): value is TodoMethod {
  return typeof value === 'string' && (TODO_METHODS as readonly string[]).includes(value);
}

/** Whether a renderer-supplied string is one of the allowed bot-todo methods. */
function isBotTodoMethod(value: unknown): value is BotTodoMethod {
  return typeof value === 'string' && (BOT_TODO_METHODS as readonly string[]).includes(value);
}

/** Registers the Desktop todo channel. */
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

/** Registers the separate bot-todo mutation channel. */
export function registerBotTodoIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.botTodoRequest, async (event, method: unknown, params: unknown) => {
    assertShellSender(event.sender);
    if (!isBotTodoMethod(method)) throw new Error(`不支持的机器人待办方法：${String(method)}`);
    return options.request(method, params);
  });

  return () => {
    ipcMain.removeHandler(SHELL_CHANNELS.botTodoRequest);
  };
}
