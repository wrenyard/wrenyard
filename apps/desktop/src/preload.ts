import { contextBridge, ipcRenderer } from 'electron';
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '@wrenyard/themes';
import {
  SHELL_CHANNELS,
  isShellPage,
  type AppearanceSettings,
  type ResolvedAppearance,
  type StatsSnapshot,
  type QuotaSnapshot,
  type SettingsSnapshot,
  type WorkspaceConfigurationSnapshot,
  type UpdateSnapshot,
  type DaemonLifecycleSnapshot,
  type ShellPage,
  type WrenyardShellApi,
  type TaskSettingsSaveRequest,
  type TaskSettingsSnapshot,
  type RuntimeAliasPutRequest,
  type RuntimeAliasRemoveRequest,
  type RuntimeAliasSnapshot,
  type TaskRoutingTestParams,
  type TaskRoutingTestResult,
  type TaskRoutingTestTasksResult,
  type SummarySettingsSnapshot,
  type ExecStartRequest,
  type ExecSnapshotDto,
  type ExecEventsRequest,
  type ExecEventsResult,
  type ExecCancelResult,
} from './shell-contract.js';
import { exposeSession } from './session/preload.js';

const APPEARANCE_ARG_PREFIX = '--wy-appearance=';

/**
 * Read the main-process-resolved appearance from `additionalArguments`. An
 * absent or malformed argument falls back to the default theme, light, and
 * system motion rather than failing the preload.
 */
function readInitialAppearance(): ResolvedAppearance {
  const raw = process.argv.find((argument) => argument.startsWith(APPEARANCE_ARG_PREFIX));
  const value = raw?.slice(APPEARANCE_ARG_PREFIX.length);
  if (value) {
    const [theme, mode, motion] = value.split(':');
    if (
      typeof theme === 'string'
      && BUILTIN_THEMES.some((entry) => entry.id === theme)
      && (mode === 'light' || mode === 'dark')
      && (motion === 'system' || motion === 'reduce')
    ) {
      return { theme: theme as ResolvedAppearance['theme'], dark: mode === 'dark', reduceMotion: motion === 'reduce' };
    }
  }
  return { theme: DEFAULT_THEME_ID, dark: false, reduceMotion: false };
}

const api: WrenyardShellApi = {
  platform: process.platform,
  initialAppearance: readInitialAppearance(),
  getAppearance(): Promise<ResolvedAppearance> {
    return ipcRenderer.invoke(SHELL_CHANNELS.appearanceSnapshot) as Promise<ResolvedAppearance>;
  },
  getAppearanceSettings(): Promise<AppearanceSettings> {
    return ipcRenderer.invoke(SHELL_CHANNELS.appearanceSettingsSnapshot) as Promise<AppearanceSettings>;
  },
  setAppearance(settings: Partial<AppearanceSettings>): Promise<AppearanceSettings> {
    return ipcRenderer.invoke(SHELL_CHANNELS.saveAppearance, settings) as Promise<AppearanceSettings>;
  },
  onAppearanceChanged(listener: (appearance: ResolvedAppearance) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, appearance: ResolvedAppearance): void => {
      listener(appearance);
    };
    ipcRenderer.on(SHELL_CHANNELS.appearanceChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.appearanceChanged, handler);
  },
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
  openProviderKeyPage(providerId: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.openProviderKeyPage, providerId) as Promise<void>;
  },
  getUpdate(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.updateSnapshot) as Promise<UpdateSnapshot>;
  },
  checkUpdate(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.checkUpdate) as Promise<UpdateSnapshot>;
  },
  requestInstall(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.requestInstall) as Promise<UpdateSnapshot>;
  },
  getDaemon(): Promise<DaemonLifecycleSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.daemonSnapshot) as Promise<DaemonLifecycleSnapshot>;
  },
  startDaemon(): Promise<DaemonLifecycleSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.daemonStart) as Promise<DaemonLifecycleSnapshot>;
  },
  restartDaemon(): Promise<DaemonLifecycleSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.daemonRestart) as Promise<DaemonLifecycleSnapshot>;
  },
  onDaemonChanged(listener: () => void): () => void {
    const handler = (): void => listener();
    ipcRenderer.on(SHELL_CHANNELS.daemonChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.daemonChanged, handler);
  },
  savePetSettings(settings): Promise<SettingsSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.savePetSettings, settings) as Promise<SettingsSnapshot>;
  },
  saveWorkspace(path: string, create?: boolean): Promise<WorkspaceConfigurationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.saveWorkspace, path, create) as Promise<WorkspaceConfigurationSnapshot>;
  },
  copyText(text: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.copyText, text);
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.openExternal, url);
  },
  openTaskTranscript(taskRunId: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.taskTranscript, taskRunId);
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
  requestTaskRoutingTest(params: TaskRoutingTestParams): Promise<TaskRoutingTestResult> {
    return ipcRenderer.invoke(SHELL_CHANNELS.taskRoutingTest, params) as Promise<TaskRoutingTestResult>;
  },
  requestRoutingTestTasks(): Promise<TaskRoutingTestTasksResult> {
    return ipcRenderer.invoke(SHELL_CHANNELS.taskRoutingTestTasks) as Promise<TaskRoutingTestTasksResult>;
  },
  getSummarySettings(): Promise<SummarySettingsSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.summaryModelSnapshot) as Promise<SummarySettingsSnapshot>;
  },
  saveSummaryModel(canonicalModel: string): Promise<SummarySettingsSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.summaryModelSave, canonicalModel) as Promise<SummarySettingsSnapshot>;
  },
  execStart(request: ExecStartRequest): Promise<ExecSnapshotDto> {
    return ipcRenderer.invoke(SHELL_CHANNELS.execStart, request) as Promise<ExecSnapshotDto>;
  },
  execGet(id: string): Promise<ExecSnapshotDto> {
    return ipcRenderer.invoke(SHELL_CHANNELS.execGet, id) as Promise<ExecSnapshotDto>;
  },
  execEvents(request: ExecEventsRequest): Promise<ExecEventsResult> {
    return ipcRenderer.invoke(SHELL_CHANNELS.execEvents, request) as Promise<ExecEventsResult>;
  },
  execCancel(id: string): Promise<ExecCancelResult> {
    return ipcRenderer.invoke(SHELL_CHANNELS.execCancel, id) as Promise<ExecCancelResult>;
  },
};

contextBridge.exposeInMainWorld('wrenyardShell', api);

// Independent session test surface; it never touches the shell contract.
exposeSession();
