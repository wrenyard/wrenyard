// Quota/provider IPC: the quota snapshot/refresh, provider order persistence,
// and provider API-key configuration and key-page opening. Handler semantics
// are unchanged from the original inline registrations.

import { shell, type IpcMain } from 'electron';
import { SHELL_CHANNELS, providerKeyPageUrl } from '../../shell-contract.js';
import type { ShellIpcDeps } from './deps.js';

export function registerQuotaProvidersIpc(ipcMain: IpcMain, deps: ShellIpcDeps): () => void {
  const { options, assertShellSender } = deps;

  ipcMain.handle(SHELL_CHANNELS.quotaSnapshot, async (event, forceRefresh: unknown) => {
    assertShellSender(event.sender);
    if (forceRefresh !== undefined && typeof forceRefresh !== 'boolean') throw new Error('额度刷新参数无效');
    return options.getQuota(forceRefresh === true);
  });
  ipcMain.handle(SHELL_CHANNELS.saveProviderOrder, async (event, providerIds: unknown) => {
    assertShellSender(event.sender);
    if (!Array.isArray(providerIds) || providerIds.length > 256
      || providerIds.some((id) => typeof id !== 'string' || !id || id.length > 256)) {
      throw new Error('Provider 顺序无效');
    }
    return options.saveProviderOrder(providerIds);
  });
  ipcMain.handle(SHELL_CHANNELS.configureProviderKey, async (event, providerId: unknown, key: unknown) => {
    assertShellSender(event.sender);
    if (typeof providerId !== 'string' || !providerId || providerId.length > 256) throw new Error('Provider id 无效');
    if (typeof key !== 'string' || !key || key.length > 4096) throw new Error('API Key 无效');
    return options.configureProviderKey(providerId, key);
  });
  ipcMain.handle(SHELL_CHANNELS.signInProvider, async (event, providerId: unknown, input: unknown) => {
    assertShellSender(event.sender);
    if (providerId !== 'workbuddy' && providerId !== 'workbuddy-ai') throw new Error('不支持的登录提供方');
    if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
      throw new Error('登录参数无效');
    }
    const params = input as { switchAccount?: unknown; source?: unknown } | undefined;
    if (params?.switchAccount !== undefined && typeof params.switchAccount !== 'boolean') throw new Error('登录参数无效');
    if (params?.source !== undefined && params.source !== 'browser' && params.source !== 'desktop') throw new Error('登录来源无效');
    return options.request('provider.signIn', { ...params, provider: providerId });
  });
  ipcMain.handle(SHELL_CHANNELS.openProviderKeyPage, async (event, providerId: unknown) => {
    assertShellSender(event.sender);
    const url = providerKeyPageUrl(providerId);
    if (url === null) throw new Error('不支持的 Provider 密钥页面');
    await shell.openExternal(url);
  });

  return () => {
    for (const channel of [
      SHELL_CHANNELS.quotaSnapshot,
      SHELL_CHANNELS.saveProviderOrder,
      SHELL_CHANNELS.configureProviderKey,
      SHELL_CHANNELS.signInProvider,
      SHELL_CHANNELS.openProviderKeyPage,
    ]) ipcMain.removeHandler(channel);
  };
}
