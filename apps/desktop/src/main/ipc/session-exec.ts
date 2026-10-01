// Session/utility IPC: raw prompt execution transport and the clipboard /
// external-link helpers. Handler semantics are unchanged from the original
// inline registrations.

import { clipboard, shell, type IpcMain } from 'electron';
import { SHELL_CHANNELS } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';
import { isBoundedExecId, validateExecEventsRequest, validateExecStartRequest } from './validation.js';

export function registerSessionExecIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.copyText, (event, text: unknown) => {
    assertShellSender(event.sender);
    if (typeof text !== 'string' || text.length > 4_000_000) throw new Error('复制文本无效');
    clipboard.writeText(text);
  });
  ipcMain.handle(SHELL_CHANNELS.openExternal, async (event, url: unknown) => {
    assertShellSender(event.sender);
    if (typeof url !== 'string' || url === '') throw new Error('无效链接');
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error('无效链接');
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('不支持的链接协议');
    await shell.openExternal(target.toString());
  });
  ipcMain.handle(SHELL_CHANNELS.execStart, async (event, request: unknown) => {
    assertShellSender(event.sender);
    return options.execStart(validateExecStartRequest(request));
  });
  ipcMain.handle(SHELL_CHANNELS.execGet, async (event, id: unknown) => {
    assertShellSender(event.sender);
    if (!isBoundedExecId(id)) throw new Error('执行 id 无效');
    return options.execGet(id);
  });
  ipcMain.handle(SHELL_CHANNELS.execEvents, async (event, request: unknown) => {
    assertShellSender(event.sender);
    return options.execEvents(validateExecEventsRequest(request));
  });
  ipcMain.handle(SHELL_CHANNELS.execCancel, async (event, id: unknown) => {
    assertShellSender(event.sender);
    if (!isBoundedExecId(id)) throw new Error('执行 id 无效');
    return options.execCancel(id);
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.copyText,
      SHELL_CHANNELS.openExternal,
      SHELL_CHANNELS.execStart,
      SHELL_CHANNELS.execGet,
      SHELL_CHANNELS.execEvents,
      SHELL_CHANNELS.execCancel,
    ]) ipcMain.removeHandler(channel);
  };
}
