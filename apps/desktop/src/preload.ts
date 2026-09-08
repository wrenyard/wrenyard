import { contextBridge, ipcRenderer } from 'electron';
import {
  SHELL_CHANNELS,
  isShellPage,
  type StatsSnapshot,
  type QuotaSnapshot,
  type SettingsSnapshot,
  type ConversationSnapshot,
  type WorkspaceConfigurationSnapshot,
  type UpdateChannel,
  type UpdateSnapshot,
  type ShellPage,
  type WrenyardShellApi,
  type TaskSettingsSaveRequest,
  type TaskSettingsSnapshot,
  type RuntimeAliasPutRequest,
  type RuntimeAliasRemoveRequest,
  type RuntimeAliasSnapshot,
} from './shell-contract.js';

const api: WrenyardShellApi = {
  platform: process.platform,
  navigate(page: ShellPage): Promise<void> {
    if (!isShellPage(page)) return Promise.reject(new Error('Unsupported shell page'));
    return ipcRenderer.invoke(SHELL_CHANNELS.navigate, page) as Promise<void>;
  },
  getSettings(): Promise<SettingsSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.settingsSnapshot) as Promise<SettingsSnapshot>;
  },
  getStats(): Promise<StatsSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.statsSnapshot) as Promise<StatsSnapshot>;
  },
  getQuota(forceRefresh = false): Promise<QuotaSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.quotaSnapshot, forceRefresh) as Promise<QuotaSnapshot>;
  },
  saveProviderOrder(providerIds: string[]): Promise<QuotaSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.saveProviderOrder, providerIds) as Promise<QuotaSnapshot>;
  },
  configureProviderKey(providerId: string, key: string): Promise<QuotaSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.configureProviderKey, providerId, key) as Promise<QuotaSnapshot>;
  },
  getClientConfiguration() {
    return ipcRenderer.invoke(SHELL_CHANNELS.clientConfigurationSnapshot);
  },
  planClientConfiguration(clientId, selection) {
    return ipcRenderer.invoke(SHELL_CHANNELS.clientConfigurationPlan, clientId, selection);
  },
  applyClientConfiguration(plan) {
    return ipcRenderer.invoke(SHELL_CHANNELS.clientConfigurationApply, plan);
  },
  planClientConfigurationRestore(clientId) {
    return ipcRenderer.invoke(SHELL_CHANNELS.clientConfigurationPlanRestore, clientId);
  },
  restoreClientConfiguration(plan) {
    return ipcRenderer.invoke(SHELL_CHANNELS.clientConfigurationRestore, plan);
  },
  getUpdate(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.updateSnapshot) as Promise<UpdateSnapshot>;
  },
  checkUpdate(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.checkUpdate) as Promise<UpdateSnapshot>;
  },
  setUpdateChannel(channel: UpdateChannel): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.setUpdateChannel, channel) as Promise<UpdateSnapshot>;
  },
  requestInstall(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.requestInstall) as Promise<UpdateSnapshot>;
  },
  cancelPendingInstall(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.cancelPendingInstall) as Promise<UpdateSnapshot>;
  },
  savePetSettings(settings): Promise<SettingsSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.savePetSettings, settings) as Promise<SettingsSnapshot>;
  },
  saveWorkspace(path: string): Promise<WorkspaceConfigurationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.saveWorkspace, path) as Promise<WorkspaceConfigurationSnapshot>;
  },
  getConversation(): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.conversationSnapshot) as Promise<ConversationSnapshot>;
  },
  selectConversation(sessionId: string): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.conversationSelect, sessionId) as Promise<ConversationSnapshot>;
  },
  createConversation(): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.conversationCreate) as Promise<ConversationSnapshot>;
  },
  selectConversationModel(provider: string, model: string): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.conversationSelectModel, provider, model) as Promise<ConversationSnapshot>;
  },
  sendConversation(text: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.conversationSend, text, clientTimeZone) as Promise<ConversationSnapshot>;
  },
  cancelConversation(): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.conversationCancel) as Promise<ConversationSnapshot>;
  },
  onConversationChanged(listener: () => void): () => void {
    const handler = (): void => listener();
    ipcRenderer.on(SHELL_CHANNELS.conversationChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.conversationChanged, handler);
  },
  onQuotaChanged(listener: () => void): () => void {
    const handler = (): void => listener();
    ipcRenderer.on(SHELL_CHANNELS.quotaChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.quotaChanged, handler);
  },
  onUpdateChanged(listener: () => void): () => void {
    const handler = (): void => listener();
    ipcRenderer.on(SHELL_CHANNELS.updateChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.updateChanged, handler);
  },
  onViewChanged(listener: (page: ShellPage) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, page: unknown): void => {
      if (isShellPage(page)) listener(page);
    };
    ipcRenderer.on(SHELL_CHANNELS.viewChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.viewChanged, handler);
  },
  getTaskSettings(project?: string, taskId?: string): Promise<TaskSettingsSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.taskSettingsSnapshot, project, taskId) as Promise<TaskSettingsSnapshot>;
  },
  saveTaskSettings(request: TaskSettingsSaveRequest): Promise<TaskSettingsSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.taskSettingsSave, request) as Promise<TaskSettingsSnapshot>;
  },
  runtimeAliasSnapshot(): Promise<RuntimeAliasSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.runtimeAliasSnapshot) as Promise<RuntimeAliasSnapshot>;
  },
  runtimeAliasPut(request: RuntimeAliasPutRequest): Promise<RuntimeAliasSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.runtimeAliasPut, request) as Promise<RuntimeAliasSnapshot>;
  },
  runtimeAliasRemove(request: RuntimeAliasRemoveRequest): Promise<RuntimeAliasSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.runtimeAliasRemove, request) as Promise<RuntimeAliasSnapshot>;
  },
};

contextBridge.exposeInMainWorld('wrenyardShell', api);
