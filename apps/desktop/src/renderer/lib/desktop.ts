/**
 * Renderer-side desktop bridge. This is the only renderer module that reads
 * `window.wrenyardShell`; UI components call these named functions and hooks
 * instead of touching the preload facade directly.
 */
import { useSyncExternalStore } from 'react';
import type {
  DaemonLifecycleSnapshot,
  ExecCancelResult,
  ExecEventsRequest,
  ExecEventsResult,
  ExecSnapshotDto,
  ExecStartRequest,
  PetCompanionSettings,
  QuotaSnapshot,
  RuntimeAliasPutRequest,
  RuntimeAliasRemoveRequest,
  RuntimeAliasSnapshot,
  SettingsSnapshot,
  ShellPage,
  StatsSnapshot,
  SummarySettingsSnapshot,
  TaskRoutingTestParams,
  TaskRoutingTestResult,
  TaskRoutingTestTasksResult,
  TaskSettingsSaveRequest,
  TaskSettingsSnapshot,
  UpdateSnapshot,
  WorkspaceConfigurationSnapshot,
  WrenyardShellApi,
} from '@/shell-contract';

declare global {
  interface Window {
    wrenyardShell: WrenyardShellApi;
  }
}

function shell(): WrenyardShellApi {
  return window.wrenyardShell;
}

/* ------------------------------------------------------------------ */
/* Clipboard and external navigation                                   */
/* ------------------------------------------------------------------ */

/**
 * Copy text through the shell bridge, falling back to the browser clipboard
 * when the bridge rejects or is unavailable.
 */
export async function copyText(text: string): Promise<void> {
  const bridge = shell();
  if (bridge && typeof bridge.copyText === 'function') {
    try {
      await bridge.copyText(text);
      return;
    } catch {
      // Fall through to the web clipboard when the shell bridge rejects.
    }
  }
  await navigator.clipboard.writeText(text);
}

/** Open an `http(s)` URL in the OS browser through the shell bridge. */
export function openExternal(url: string): Promise<void> {
  return shell().openExternal(url);
}

/** Open a task-run transcript through the shell bridge. */
export function openTaskTranscript(taskRunId: string): Promise<void> {
  return shell().openTaskTranscript(taskRunId);
}

/* ------------------------------------------------------------------ */
/* Settings, stats and quota                                           */
/* ------------------------------------------------------------------ */

export function getSettings(): Promise<SettingsSnapshot> {
  return shell().getSettings();
}

export function getStats(): Promise<StatsSnapshot> {
  return shell().getStats();
}

export function getQuota(forceRefresh = false): Promise<QuotaSnapshot> {
  return shell().getQuota(forceRefresh);
}

export function saveProviderOrder(providerIds: string[]): Promise<QuotaSnapshot> {
  return shell().saveProviderOrder(providerIds);
}

export function configureProviderKey(providerId: string, key: string): Promise<QuotaSnapshot> {
  return shell().configureProviderKey(providerId, key);
}

export function openProviderKeyPage(providerId: string): Promise<void> {
  return shell().openProviderKeyPage(providerId);
}

/* ------------------------------------------------------------------ */
/* Updates, daemon and workspace                                       */
/* ------------------------------------------------------------------ */

export function getUpdate(): Promise<UpdateSnapshot> {
  return shell().getUpdate();
}

export function checkUpdate(): Promise<UpdateSnapshot> {
  return shell().checkUpdate();
}

export function requestInstall(): Promise<UpdateSnapshot> {
  return shell().requestInstall();
}

export function getDaemon(): Promise<DaemonLifecycleSnapshot> {
  return shell().getDaemon();
}

export function startDaemon(): Promise<DaemonLifecycleSnapshot> {
  return shell().startDaemon();
}

export function restartDaemon(): Promise<DaemonLifecycleSnapshot> {
  return shell().restartDaemon();
}

export function savePetSettings(settings: PetCompanionSettings): Promise<SettingsSnapshot> {
  return shell().savePetSettings(settings);
}

export function saveWorkspace(path: string, create?: boolean): Promise<WorkspaceConfigurationSnapshot> {
  return shell().saveWorkspace(path, create);
}

/* ------------------------------------------------------------------ */
/* Task settings, aliases and routing                                  */
/* ------------------------------------------------------------------ */

export function getTaskSettings(project?: string, taskId?: string): Promise<TaskSettingsSnapshot> {
  return shell().getTaskSettings(project, taskId);
}

export function saveTaskSettings(request: TaskSettingsSaveRequest): Promise<TaskSettingsSnapshot> {
  return shell().saveTaskSettings(request);
}

export function runtimeAliasSnapshot(): Promise<RuntimeAliasSnapshot> {
  return shell().runtimeAliasSnapshot();
}

export function runtimeAliasPut(request: RuntimeAliasPutRequest): Promise<RuntimeAliasSnapshot> {
  return shell().runtimeAliasPut(request);
}

export function runtimeAliasRemove(request: RuntimeAliasRemoveRequest): Promise<RuntimeAliasSnapshot> {
  return shell().runtimeAliasRemove(request);
}

export function requestTaskRoutingTest(params: TaskRoutingTestParams): Promise<TaskRoutingTestResult> {
  return shell().requestTaskRoutingTest(params);
}

export function requestRoutingTestTasks(): Promise<TaskRoutingTestTasksResult> {
  return shell().requestRoutingTestTasks();
}

export function getSummarySettings(): Promise<SummarySettingsSnapshot> {
  return shell().getSummarySettings();
}

export function saveSummaryModel(canonicalModel: string): Promise<SummarySettingsSnapshot> {
  return shell().saveSummaryModel(canonicalModel);
}

/* ------------------------------------------------------------------ */
/* Raw prompt execution                                                */
/* ------------------------------------------------------------------ */

export function execStart(request: ExecStartRequest): Promise<ExecSnapshotDto> {
  return shell().execStart(request);
}

export function execGet(id: string): Promise<ExecSnapshotDto> {
  return shell().execGet(id);
}

export function execEvents(request: ExecEventsRequest): Promise<ExecEventsResult> {
  return shell().execEvents(request);
}

export function execCancel(id: string): Promise<ExecCancelResult> {
  return shell().execCancel(id);
}

/* ------------------------------------------------------------------ */
/* Bridge subscriptions                                                */
/* ------------------------------------------------------------------ */

export function onQuotaChanged(listener: () => void): () => void {
  return shell().onQuotaChanged(listener);
}

export function onUpdateChanged(listener: () => void): () => void {
  return shell().onUpdateChanged(listener);
}

export function onDaemonChanged(listener: () => void): () => void {
  return shell().onDaemonChanged(listener);
}

export function onViewChanged(listener: (page: ShellPage) => void): () => void {
  return shell().onViewChanged(listener);
}

/* ------------------------------------------------------------------ */
/* Shell page navigation                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_SHELL_PAGE: ShellPage = 'session';
let shellPage: ShellPage = DEFAULT_SHELL_PAGE;
const pageListeners = new Set<() => void>();

function publishShellPage(page: ShellPage): void {
  if (page === shellPage) return;
  shellPage = page;
  for (const listener of pageListeners) listener();
}

// Register the push subscription at module load so the very first
// `view-changed` event from the main process is never missed.
window.wrenyardShell.onViewChanged(publishShellPage);

/** Ask the main process to navigate to a shell page. */
export function navigate(page: ShellPage): Promise<void> {
  return shell().navigate(page);
}

function subscribeShellPage(listener: () => void): () => void {
  pageListeners.add(listener);
  return () => {
    pageListeners.delete(listener);
  };
}

function getShellPage(): ShellPage {
  return shellPage;
}

/** Current shell page, kept in sync by the bridge `view-changed` push. */
export function useShellPage(): ShellPage {
  return useSyncExternalStore(subscribeShellPage, getShellPage, getShellPage);
}
