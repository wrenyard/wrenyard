// Agent-client IPC: one read-only channel with its own method allowlist. The
// `client` channel accepts only `client.list`; the registrar mirrors the other
// domain handlers: assert the shell sender first, validate the method against
// the channel's allowlist, then delegate to the injected daemon request
// transport. Recognized client refusals are translated before Electron
// serialization; other errors pass through unchanged.

import type { IpcMain } from 'electron';
import { CLIENT_METHODS, SHELL_CHANNELS } from '../../shell-contract.js';
import type { ClientMethod } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';
import { WrenyardRpcError } from '@wrenyard/control';
import { INVALID_PARAMS } from '@wrenyard/protocol/common';

const clientRefusalMessages: Record<string, string> = {
  active_executions: '当前有任务运行中，请等待任务结束后再安装或升级客户端。',
  client_busy: '该客户端正在安装或升级，请等待当前操作完成。',
  npm_unavailable: '未找到 npm，请先安装 npm 后再安装或升级客户端。',
  unsupported_source: '当前客户端不支持通过 npm 安装或升级，请使用原安装方式管理。',
  already_installed: '该客户端已安装，请选择升级。',
  not_installed: '该客户端尚未安装，请先安装。',
  unknown_client: '未找到该客户端，请刷新客户端列表后重试。',
};

function translatedClientRefusal(error: unknown): Error | undefined {
  if (!(error instanceof WrenyardRpcError) || error.code !== INVALID_PARAMS.code) return undefined;
  const data = error.data;
  if (typeof data !== 'object' || data === null || !('service' in data) || data.service !== 'client'
    || !('code' in data) || typeof data.code !== 'string') return undefined;
  if (!Object.hasOwn(clientRefusalMessages, data.code)) return undefined;
  return new Error(clientRefusalMessages[data.code]!);
}

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
    try {
      return await options.request(method, params);
    } catch (error) {
      const translated = translatedClientRefusal(error);
      if (translated !== undefined) throw translated;
      throw error;
    }
  });

  return () => {
    ipcMain.removeHandler(SHELL_CHANNELS.clientRequest);
  };
}
