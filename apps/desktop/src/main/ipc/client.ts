// Agent-client IPC: one read-only channel with its own method allowlist. The
// `client` channel accepts only `client.list`; the registrar mirrors the other
// domain handlers: assert the shell sender first, validate the method against
// the channel's allowlist, then delegate to the injected daemon request
// transport. Desktop never inspects a client itself; a daemon error rejects
// the invoke unchanged.

import type { IpcMain } from 'electron';
import { CLIENT_METHODS, SHELL_CHANNELS } from '../../shell-contract.js';
import type { ClientMethod } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

/** Whether a renderer-supplied string is the one allowed client method. */
function isClientMethod(value: unknown): value is ClientMethod {
  return typeof value === 'string' && (CLIENT_METHODS as readonly string[]).includes(value);
}

/** Registers the read-only `client` channel; `client.list` is its only method. */
export function registerClientIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.clientRequest, async (event, method: unknown, params: unknown) => {
    assertShellSender(event.sender);
    if (!isClientMethod(method)) throw new Error(`不支持的客户端方法：${String(method)}`);
    return options.request(method, params);
  });

  return () => {
    ipcMain.removeHandler(SHELL_CHANNELS.clientRequest);
  };
}
