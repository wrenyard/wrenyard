// Bot-mode IPC: one channel forwarding an allowlisted set of `bot.*` daemon
// methods. Handler semantics mirror the other domain registrars: assert the
// shell sender first, validate the bounded arguments, then delegate to the
// shell options. Desktop never runs a bot step; it only transports the call.

import type { IpcMain } from 'electron';
import { BOT_METHODS, SHELL_CHANNELS } from '../../shell-contract.js';
import type { BotMethod } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

/** Whether a renderer-supplied string is one of the ten allowed bot methods. */
function isBotMethod(value: unknown): value is BotMethod {
  return typeof value === 'string' && (BOT_METHODS as readonly string[]).includes(value);
}

export function registerBotIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.botRequest, async (event, method: unknown, params: unknown) => {
    assertShellSender(event.sender);
    if (!isBotMethod(method)) throw new Error(`不支持的机器人方法：${String(method)}`);
    return options.requestBot(method, params);
  });

  return () => {
    ipcMain.removeHandler(SHELL_CHANNELS.botRequest);
  };
}
