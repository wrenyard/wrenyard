import { contextBridge, ipcRenderer } from 'electron';
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '@wrenyard/themes';
import {
  SHELL_CHANNELS,
  isShellPage,
  type AppearanceSettings,
  type AppMenuPosition,
  type ResolvedAppearance,
  type WindowStateSnapshot,
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
  type NotificationSnapshot,
  type ShellNotification,
  type NotificationInput,
  type NotificationCommandAction,
  type DesktopPreferences,
  type PreferenceId,
  type ActivityStatusSnapshot,
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

/** A command action is the only main→renderer command payload; validate shape. */
function isNotificationCommandAction(value: unknown): value is NotificationCommandAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  return typeof action.id === 'string' && action.id.length > 0;
}

/** Window state arrives from the main process; accept only the typed shape. */
function isWindowStateSnapshot(value: unknown): value is WindowStateSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return typeof (value as { fullscreen?: unknown }).fullscreen === 'boolean';
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
  showAppMenu(position?: AppMenuPosition): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.showAppMenu, position) as Promise<void>;
  },
  onWindowStateChanged(listener: (state: WindowStateSnapshot) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => {
      if (isWindowStateSnapshot(state)) listener(state);
    };
    ipcRenderer.on(SHELL_CHANNELS.windowStateChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.windowStateChanged, handler);
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
  openTaskGraph(taskGraphId: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.taskGraph, taskGraphId);
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
  getNotifications(): Promise<NotificationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.notificationsSnapshot) as Promise<NotificationSnapshot>;
  },
  notify(input: NotificationInput): Promise<ShellNotification> {
    return ipcRenderer.invoke(SHELL_CHANNELS.notificationNotify, input) as Promise<ShellNotification>;
  },
  dismissNotification(id: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.notificationDismiss, id) as Promise<void>;
  },
  clearNotifications(): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.notificationsClear) as Promise<void>;
  },
  markNotificationsRead(): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.notificationsMarkRead) as Promise<void>;
  },
  setDoNotDisturb(value: boolean): Promise<NotificationSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.notificationsSetDoNotDisturb, value) as Promise<NotificationSnapshot>;
  },
  onNotificationsChanged(listener: () => void): () => void {
    const handler = (): void => listener();
    ipcRenderer.on(SHELL_CHANNELS.notificationsChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.notificationsChanged, handler);
  },
  onCommandAction(listener: (action: NotificationCommandAction) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, action: unknown): void => {
      if (isNotificationCommandAction(action)) listener(action);
    };
    ipcRenderer.on(SHELL_CHANNELS.commandAction, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.commandAction, handler);
  },
  getPreferences(): Promise<DesktopPreferences> {
    return ipcRenderer.invoke(SHELL_CHANNELS.preferencesSnapshot) as Promise<DesktopPreferences>;
  },
  setPreference(id: PreferenceId, value: unknown): Promise<DesktopPreferences> {
    return ipcRenderer.invoke(SHELL_CHANNELS.setPreference, id, value) as Promise<DesktopPreferences>;
  },
  getActivityStatus(): Promise<ActivityStatusSnapshot> {
    return ipcRenderer.invoke(SHELL_CHANNELS.activityStatusSnapshot) as Promise<ActivityStatusSnapshot>;
  },
  onActivityChanged(listener: (snapshot: ActivityStatusSnapshot) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: ActivityStatusSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on(SHELL_CHANNELS.activityChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.activityChanged, handler);
  },
  onPreferencesChanged(listener: (preferences: DesktopPreferences) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, preferences: DesktopPreferences): void => {
      listener(preferences);
    };
    ipcRenderer.on(SHELL_CHANNELS.preferencesChanged, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.preferencesChanged, handler);
  },
  openSettingsFile(): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.openSettingsFile) as Promise<void>;
  },
  openLogsDirectory(): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.openLogsDirectory) as Promise<void>;
  },
  revealWorkspace(path: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_CHANNELS.revealWorkspace, path) as Promise<void>;
  },
};

contextBridge.exposeInMainWorld('wrenyardShell', api);

// Independent session test surface; it never touches the shell contract.
exposeSession();
