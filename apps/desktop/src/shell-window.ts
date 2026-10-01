import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  shell,
  type BrowserWindowConstructorOptions,
  type Input,
  type WebContents,
} from 'electron';
import { BUILTIN_THEMES } from '@wrenyard/themes';
import type { PageLoader } from './pages.js';
import {
  SHELL_CHANNELS,
  acceleratorPage,
  isPreferenceId,
  isShellPage,
  providerKeyPageUrl,
  type AppearanceSettings,
  type DesktopPreferences,
  type PreferenceId,
  type StatsSnapshot,
  type QuotaSnapshot,
  type ResolvedAppearance,
  type SettingsSnapshot,
  type PetCompanionSettings,
  type ShellPage,
  type WorkspaceConfigurationSnapshot,
  type UpdateSnapshot,
  type RuntimeAliasPutRequest,
  type RuntimeAliasRemoveRequest,
  type RuntimeAliasSnapshot,
  type TaskSettingsSaveRequest,
  type TaskSettingsSnapshot,
  type TaskSettingsAutomaticDispatch,
  type TaskRoutingTestParams,
  type TaskRoutingTestResult,
  type TaskRoutingTestTasksResult,
  type SummarySettingsSnapshot,
  type ExecStartRequest,
  type ExecSnapshotDto,
  type ExecEventsRequest,
  type ExecEventsResult,
  type ExecCancelResult,
  type NotificationCommandAction,
  type NotificationInput,
  type NotificationSnapshot,
  type ShellNotification,
  type ActivityStatusSnapshot,
} from './shell-contract.js';
import { formatShellWindowTitle } from './shell-window-title.js';
import { TITLE_BAR_HEIGHT, platformWindowChrome } from './window-chrome.js';

/**
 * Back/forward accelerators that are not application-menu items: macOS uses
 * Cmd+[ / Cmd+] and Windows/Linux use Alt+← / Alt+→. The native swipe and
 * app-command events below cover touchpad and mouse side-button gestures.
 */
function navCommandForInput(input: Input, platform: NodeJS.Platform): 'nav.back' | 'nav.forward' | null {
  if (platform === 'darwin') {
    if (input.meta !== true) return null;
    if (input.key === '[') return 'nav.back';
    if (input.key === ']') return 'nav.forward';
    return null;
  }
  if (input.alt !== true) return null;
  if (input.key === 'ArrowLeft') return 'nav.back';
  if (input.key === 'ArrowRight') return 'nav.forward';
  return null;
}

export interface ShellWindowOptions {
  pageLoader: PageLoader;
  preloadPath: string;
  appVersion: string;
  smoke: boolean;
  icon?: string;
  /** Resolved appearance at creation time: background, chrome palette and args. */
  initialAppearance: ResolvedAppearance;
  backgroundColor: string;
  titleBarOverlay: { color: string; symbolColor: string };
  additionalArguments: string[];
  /** Initial shell page; `general.startupPage` resolves it from the last page. */
  initialPage?: ShellPage;
  /** Invoked whenever the shell page changes, so main can persist the last page. */
  onPageChanged?(page: ShellPage): void;
  onCreated?(controller: ShellWindowController): void;
  getAppearance(): ResolvedAppearance;
  getSettings(): Promise<SettingsSnapshot>;
  getStats(): Promise<StatsSnapshot>;
  getQuota(forceRefresh?: boolean): Promise<QuotaSnapshot>;
  saveProviderOrder(providerIds: string[]): Promise<QuotaSnapshot>;
  configureProviderKey(providerId: string, key: string): Promise<QuotaSnapshot>;
  getUpdate(): Promise<UpdateSnapshot>;
  checkUpdate(): Promise<UpdateSnapshot>;
  requestInstall(onInstall?: () => void): Promise<UpdateSnapshot>;
  savePetSettings(settings: PetCompanionSettings): Promise<SettingsSnapshot>;
  saveWorkspace(path: string, create?: boolean): Promise<WorkspaceConfigurationSnapshot>;
  openTaskTranscript(taskRunId: string): Promise<void>;
  openTaskGraph(taskGraphId: string): Promise<void>;
  getTaskSettings(project?: string, taskId?: string): Promise<TaskSettingsSnapshot>;
  saveTaskSettings(request: TaskSettingsSaveRequest): Promise<TaskSettingsSnapshot>;
  runtimeAliasSnapshot(): Promise<RuntimeAliasSnapshot>;
  runtimeAliasPut(request: RuntimeAliasPutRequest): Promise<RuntimeAliasSnapshot>;
  runtimeAliasRemove(request: RuntimeAliasRemoveRequest): Promise<RuntimeAliasSnapshot>;
  requestTaskRoutingTest(params: TaskRoutingTestParams): Promise<TaskRoutingTestResult>;
  requestRoutingTestTasks(): Promise<TaskRoutingTestTasksResult>;
  getSummarySettings(): Promise<SummarySettingsSnapshot>;
  saveSummaryModel(canonicalModel: string): Promise<SummarySettingsSnapshot>;
  execStart(request: ExecStartRequest): Promise<ExecSnapshotDto>;
  execGet(id: string): Promise<ExecSnapshotDto>;
  execEvents(request: ExecEventsRequest): Promise<ExecEventsResult>;
  execCancel(id: string): Promise<ExecCancelResult>;
  getNotifications(): Promise<NotificationSnapshot>;
  notify(input: NotificationInput): Promise<ShellNotification>;
  dismissNotification(id: string): Promise<void>;
  clearNotifications(): Promise<void>;
  markNotificationsRead(): Promise<void>;
  setDoNotDisturb(value: boolean): Promise<NotificationSnapshot>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreference(id: PreferenceId, value: unknown): Promise<DesktopPreferences>;
  /** Latest shared activity projection for the status bar (chrome spec 4.4). */
  getActivityStatus(): ActivityStatusSnapshot;
  openSettingsFile(): Promise<void>;
  openLogsDirectory(): Promise<void>;
  revealWorkspace(path: string): Promise<void>;
}

const TASK_SETTINGS_PATCH_KEYS = new Set(['mode', 'explicit_runtime', 'timeout_ms', 'max_auto_output_usd_per_million', 'automatic']);
const TASK_SETTINGS_AUTOMATIC_KEYS = new Set([
  'expected_tps',
  'minimum_tps',
  'intelligence_min',
  'intelligence_expected',
  'max_output_usd_per_million',
  'required_capabilities',
  'requires_web_search',
  'exclude_model_ids',
  'exclude_profile_ids',
  'exclude_client_ids',
  'exclude_provider_ids',
]);
const TASK_SETTINGS_INTELLIGENCE_VALUES = new Set(['low', 'mid', 'high', 'premium']);
const TASK_SETTINGS_CAPABILITY_VALUES = new Set(['text', 'image']);
const RUNTIME_ALIAS_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RUNTIME_ALIAS_REVISION_MAX = 512;
const RUNTIME_ALIAS_TARGET_MAX = 512;
const TASK_SETTINGS_STRING_MAX = 512;
const TASK_SETTINGS_STRING_ARRAY_MAX = 64;
const TASK_SETTINGS_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function isBoundedPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedOptionalProject(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value || value.length > 4_096) throw new Error('项目参数无效');
  return value;
}

function isFinitePositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isBoundedRevision(value: unknown): value is string {
  return isBoundedString(value, RUNTIME_ALIAS_REVISION_MAX);
}

/**
 * IPC-boundary validation for an appearance patch. Only the three known
 * fields are accepted; the theme id is validated against the shared theme
 * registry so Desktop never keeps its own theme list.
 */
function validateAppearancePatch(value: unknown): Partial<AppearanceSettings> {
  if (!isBoundedPlainObject(value)) throw new Error('外观设置无效');
  const patch: Partial<AppearanceSettings> = {};
  const theme = value.theme;
  if (theme !== undefined) {
    if (typeof theme !== 'string' || !BUILTIN_THEMES.some((entry) => entry.id === theme)) {
      throw new Error('主题无效');
    }
    patch.theme = theme as AppearanceSettings['theme'];
  }
  const colorMode = value.colorMode;
  if (colorMode !== undefined) {
    if (colorMode !== 'system' && colorMode !== 'light' && colorMode !== 'dark') throw new Error('颜色模式无效');
    patch.colorMode = colorMode;
  }
  const motion = value.motion;
  if (motion !== undefined) {
    if (motion !== 'system' && motion !== 'reduce') throw new Error('动效设置无效');
    patch.motion = motion;
  }
  return patch;
}

function validateExplicitReferenceValue(explicitReference: unknown): void {
  if (explicitReference === undefined || explicitReference === null) return;
  if (!isBoundedPlainObject(explicitReference)) throw new Error('显式运行时引用无效');
  const kind = explicitReference.kind;
  if (kind === 'alias') {
    for (const field of Object.keys(explicitReference)) {
      if (field !== 'kind' && field !== 'name') throw new Error('显式运行时引用无效');
    }
    const name = explicitReference.name;
    if (typeof name !== 'string' || !RUNTIME_ALIAS_NAME.test(name)) throw new Error('显式运行时引用无效');
    return;
  }
  if (kind === 'target') {
    for (const field of Object.keys(explicitReference)) {
      if (field !== 'kind' && field !== 'target') throw new Error('显式运行时引用无效');
    }
    const target = explicitReference.target;
    if (typeof target !== 'string' || !target || target.length > TASK_SETTINGS_STRING_MAX || TASK_SETTINGS_CONTROL_CHARS.test(target)) {
      throw new Error('显式运行时引用无效');
    }
    return;
  }
  throw new Error('显式运行时引用无效');
}

function validateAutomaticDispatch(automatic: unknown, allowFieldReset = false): void {
  if (automatic === undefined || automatic === null) return;
  if (!isBoundedPlainObject(automatic)) throw new Error('自动约束无效');
  for (const key of Object.keys(automatic)) {
    if (!TASK_SETTINGS_AUTOMATIC_KEYS.has(key)) throw new Error('自动约束无效');
  }
  for (const field of ['expected_tps', 'minimum_tps', 'max_output_usd_per_million'] as const) {
    const value = automatic[field];
    if (allowFieldReset && value === null) continue;
    if (value !== undefined && !isFinitePositiveNumber(value)) throw new Error('自动约束无效');
  }
  for (const field of ['intelligence_min', 'intelligence_expected'] as const) {
    const value = automatic[field];
    if (allowFieldReset && value === null) continue;
    if (value !== undefined && (typeof value !== 'string' || !TASK_SETTINGS_INTELLIGENCE_VALUES.has(value))) {
      throw new Error('自动约束无效');
    }
  }
  const requiresWebSearch = automatic.requires_web_search;
  if (requiresWebSearch !== undefined && !(allowFieldReset && requiresWebSearch === null) && typeof requiresWebSearch !== 'boolean') {
    throw new Error('自动约束无效');
  }
  const requiredCapabilities = automatic.required_capabilities;
  if (requiredCapabilities !== undefined) {
    if (allowFieldReset && requiredCapabilities === null) {
      // A null nested patch deletes only this field from the current layer.
    } else {
    if (!Array.isArray(requiredCapabilities) || requiredCapabilities.length > 16) throw new Error('自动约束无效');
    for (const value of requiredCapabilities) {
      if (typeof value !== 'string' || !TASK_SETTINGS_CAPABILITY_VALUES.has(value)) throw new Error('自动约束无效');
    }
    }
  }
  for (const field of ['exclude_model_ids', 'exclude_profile_ids', 'exclude_client_ids', 'exclude_provider_ids'] as const) {
    const value = automatic[field];
    if (value !== undefined) {
      if (allowFieldReset && value === null) continue;
      if (!Array.isArray(value) || value.length > TASK_SETTINGS_STRING_ARRAY_MAX) throw new Error('自动约束无效');
      for (const item of value) {
        if (typeof item !== 'string' || !item || item.length > TASK_SETTINGS_STRING_MAX) throw new Error('自动约束无效');
      }
    }
  }
}

/**
 * IPC-boundary validation for task.settings.save. Desktop validates the public
 * DTO shape and bounds only; it never merges settings, so the validated request
 * is passed through to main unchanged.
 */
function validateTaskSettingsSaveRequest(value: unknown): TaskSettingsSaveRequest {
  if (!isBoundedPlainObject(value)) throw new Error('任务设置请求无效');
  const scope = value.scope;
  if (scope !== 'global' && scope !== 'task') throw new Error('任务设置作用域无效');
  const expectedRevision = value.expected_revision;
  if (typeof expectedRevision !== 'string' || !expectedRevision || expectedRevision.length > 512) {
    throw new Error('任务设置版本基线无效');
  }
  const taskId = value.task_id;
  if (taskId !== undefined && taskId !== null) {
    if (typeof taskId !== 'string' || !taskId || taskId.length > 512) throw new Error('任务 id 无效');
  }
  if (scope === 'task' && (typeof taskId !== 'string' || !taskId)) throw new Error('任务作用域必须携带 task_id');
  const project = boundedOptionalProject(value.project);
  const patch = value.patch;
  if (!isBoundedPlainObject(patch)) throw new Error('任务设置内容无效');
  for (const key of Object.keys(patch)) {
    if (!TASK_SETTINGS_PATCH_KEYS.has(key)) throw new Error('任务设置内容无效');
  }
  const autoOutputCap = patch.max_auto_output_usd_per_million;
  if (autoOutputCap !== undefined) {
    // Global-only auto-dispatch reference output cap; null clears, 0 is valid.
    // The nested per-task automatic max_output_usd_per_million stays strictly positive.
    if (scope !== 'global') throw new Error('自动派发参考输出单价上限仅支持全局作用域');
    if (autoOutputCap !== null && (typeof autoOutputCap !== 'number' || !Number.isFinite(autoOutputCap) || autoOutputCap < 0)) {
      throw new Error('自动派发参考输出单价上限无效');
    }
  }
  const mode = patch.mode;
  if (mode !== undefined && mode !== null && mode !== 'automatic' && mode !== 'explicit') throw new Error('运行时模式无效');
  validateExplicitReferenceValue(patch.explicit_runtime);
  const timeoutMs = patch.timeout_ms;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('超时设置无效');
  }
  validateAutomaticDispatch(patch.automatic, true);
  const request: TaskSettingsSaveRequest = {
    scope,
    expected_revision: expectedRevision,
    patch: patch as TaskSettingsSaveRequest['patch'],
  };
  if (taskId !== undefined && taskId !== null) request.task_id = taskId;
  if (project !== undefined) request.project = project;
  return request;
}

/**
 * IPC-boundary validation for runtime.alias.put. Desktop validates the public
 * DTO shape and bounds only; the alias store itself stays daemon-owned.
 */
function validateRuntimeAliasPutRequest(value: unknown): RuntimeAliasPutRequest {
  if (!isBoundedPlainObject(value)) throw new Error('运行时别名请求无效');
  const expectedRevision = value.expected_revision;
  if (!isBoundedRevision(expectedRevision)) throw new Error('运行时别名版本基线无效');
  const name = value.name;
  if (typeof name !== 'string' || !RUNTIME_ALIAS_NAME.test(name)) throw new Error('运行时别名格式无效');
  const target = value.target;
  if (typeof target !== 'string' || !target || target.length > RUNTIME_ALIAS_TARGET_MAX || TASK_SETTINGS_CONTROL_CHARS.test(target)) {
    throw new Error('运行时目标无效');
  }
  return { expected_revision: expectedRevision, name, target };
}

/** IPC-boundary validation for runtime.alias.remove; CAS on the store revision. */
function validateRuntimeAliasRemoveRequest(value: unknown): RuntimeAliasRemoveRequest {
  if (!isBoundedPlainObject(value)) throw new Error('运行时别名请求无效');
  const expectedRevision = value.expected_revision;
  if (!isBoundedRevision(expectedRevision)) throw new Error('运行时别名版本基线无效');
  const name = value.name;
  if (typeof name !== 'string' || !RUNTIME_ALIAS_NAME.test(name)) throw new Error('运行时别名格式无效');
  return { expected_revision: expectedRevision, name };
}

/**
 * IPC-boundary validation for task.settings.routingTest. Desktop validates the
 * typed form DTO shape and bounds only; the daemon owns evaluation, scoring,
 * and ranking, so the validated request is passed through unchanged. Unknown
 * automatic keys are rejected — an imported payload must round-trip verbatim.
 */
function validateTaskRoutingTestParams(value: unknown): TaskRoutingTestParams {
  if (!isBoundedPlainObject(value)) throw new Error('路由测试请求无效');
  const automatic = value.automatic;
  if (!isBoundedPlainObject(automatic)) throw new Error('自动约束无效');
  validateAutomaticDispatch(automatic);
  const timeoutMs = value.timeout_ms;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('超时设置无效');
  }
  const params: TaskRoutingTestParams = {
    automatic: { ...automatic } as TaskSettingsAutomaticDispatch,
  };
  if (timeoutMs !== undefined) params.timeout_ms = timeoutMs;
  return params;
}

const EXEC_ID_MAX = 200;
const EXEC_FEATURE_MAX = 32;
const EXEC_FEATURE_ID_MAX = 120;
const EXEC_PROMPT_MAX = 4_000_000;
const EXEC_CWD_MAX = 4_096;
const EXEC_MODEL_MAX = 512;
const EXEC_PROVIDER_MAX = 200;
const EXEC_CLIENT_MAX = 120;
const EXEC_SESSION_MAX = 1_024;
const EXEC_THINKING_MAX = 128;
const EXEC_MODE_VALUES = new Set(['native', 'gateway']);

function isBoundedExecId(value: unknown): value is string {
  return isBoundedString(value, EXEC_ID_MAX);
}

/**
 * IPC-boundary validation for one raw prompt execution request. Desktop only
 * checks DTO shape and bounds; the daemon owns client/model resolution, so an
 * unknown client or feature id is rejected there, not guessed here. No field
 * can smuggle a process environment or credential.
 */
function validateExecStartRequest(value: unknown): ExecStartRequest {
  if (!isBoundedPlainObject(value)) throw new Error('执行请求无效');
  const client = value.client;
  if (typeof client !== 'string' || !client.trim() || client.length > EXEC_CLIENT_MAX) throw new Error('执行客户端无效');
  const model = value.model;
  if (typeof model !== 'string' || !model.trim() || model.length > EXEC_MODEL_MAX) throw new Error('执行模型无效');
  const prompt = value.prompt;
  if (typeof prompt !== 'string' || !prompt || prompt.length > EXEC_PROMPT_MAX) throw new Error('执行提示词无效');
  const cwd = value.cwd;
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > EXEC_CWD_MAX || TASK_SETTINGS_CONTROL_CHARS.test(cwd)) {
    throw new Error('执行工作目录无效');
  }
  const request: ExecStartRequest = { client, model, prompt, cwd };
  if (value.provider !== undefined) {
    if (typeof value.provider !== 'string' || !value.provider.trim() || value.provider.length > EXEC_PROVIDER_MAX) {
      throw new Error('执行 provider 无效');
    }
    request.provider = value.provider;
  }
  if (value.mode !== undefined) {
    if (typeof value.mode !== 'string' || !EXEC_MODE_VALUES.has(value.mode)) throw new Error('执行模式无效');
    request.mode = value.mode as 'native' | 'gateway';
  }
  if (value.resumeSessionId !== undefined) {
    if (typeof value.resumeSessionId !== 'string' || !value.resumeSessionId.trim() || value.resumeSessionId.length > EXEC_SESSION_MAX) {
      throw new Error('恢复会话 id 无效');
    }
    request.resumeSessionId = value.resumeSessionId;
  }
  if (value.thinking !== undefined) {
    if (typeof value.thinking !== 'string' || !value.thinking.trim() || value.thinking.length > EXEC_THINKING_MAX) {
      throw new Error('思考强度无效');
    }
    request.thinking = value.thinking;
  }
  if (value.features !== undefined) {
    const features = value.features;
    if (!Array.isArray(features) || features.length > EXEC_FEATURE_MAX) throw new Error('执行特性列表无效');
    for (const feature of features) {
      if (typeof feature !== 'string' || !feature.trim() || feature.length > EXEC_FEATURE_ID_MAX) {
        throw new Error('执行特性 id 无效');
      }
    }
    request.features = features as string[];
  }
  return request;
}

/** IPC-boundary validation for one exec.events page request. */
function validateExecEventsRequest(value: unknown): ExecEventsRequest {
  if (!isBoundedPlainObject(value)) throw new Error('执行事件请求无效');
  const id = value.id;
  if (!isBoundedExecId(id)) throw new Error('执行 id 无效');
  const request: ExecEventsRequest = { id };
  if (value.afterSeq !== undefined) {
    const afterSeq = value.afterSeq;
    if (typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('执行事件游标无效');
    request.afterSeq = afterSeq;
  }
  return request;
}

const NOTIFICATION_LEVELS = new Set(['info', 'success', 'warning', 'error']);
const NOTIFICATION_ID_MAX = 200;
const NOTIFICATION_SOURCE_MAX = 64;
const NOTIFICATION_TITLE_MAX = 512;
const NOTIFICATION_DESCRIPTION_MAX = 4_096;
const NOTIFICATION_LABEL_MAX = 64;
const NOTIFICATION_COMMAND_ID_MAX = 200;
const NOTIFICATION_ARGS_MAX = 16_384;

/**
 * IPC-boundary validation for a renderer notification. The renderer may only
 * submit serializable data — a bounded id, level, source, title, description
 * and at most one `{ label, command }` action whose args are JSON-sized.
 */
function validateNotificationInput(value: unknown): NotificationInput {
  if (!isBoundedPlainObject(value)) throw new Error('通知内容无效');
  const level = value.level;
  if (typeof level !== 'string' || !NOTIFICATION_LEVELS.has(level)) throw new Error('通知级别无效');
  const source = value.source;
  if (typeof source !== 'string' || !source || source.length > NOTIFICATION_SOURCE_MAX) throw new Error('通知来源无效');
  const title = value.title;
  if (typeof title !== 'string' || !title || title.length > NOTIFICATION_TITLE_MAX || TASK_SETTINGS_CONTROL_CHARS.test(title)) {
    throw new Error('通知标题无效');
  }
  const input: NotificationInput = {
    level: level as NotificationInput['level'],
    source: source as NotificationInput['source'],
    title,
  };
  if (value.id !== undefined && value.id !== null) {
    const id = value.id;
    if (typeof id !== 'string' || !id || id.length > NOTIFICATION_ID_MAX) throw new Error('通知 id 无效');
    input.id = id;
  }
  if (value.description !== undefined && value.description !== null) {
    const description = value.description;
    if (typeof description !== 'string' || description.length > NOTIFICATION_DESCRIPTION_MAX) {
      throw new Error('通知描述无效');
    }
    input.description = description;
  }
  if (value.action !== undefined && value.action !== null) {
    input.action = validateNotificationAction(value.action);
  }
  return input;
}

function validateNotificationAction(value: unknown): NotificationInput['action'] {
  if (!isBoundedPlainObject(value)) throw new Error('通知操作无效');
  const label = value.label;
  if (typeof label !== 'string' || !label || label.length > NOTIFICATION_LABEL_MAX) throw new Error('通知操作无效');
  const command = value.command;
  if (!isBoundedPlainObject(command)) throw new Error('通知操作无效');
  const id = command.id;
  if (typeof id !== 'string' || !id || id.length > NOTIFICATION_COMMAND_ID_MAX) throw new Error('通知操作无效');
  let args: unknown;
  if (command.args !== undefined && command.args !== null) {
    args = command.args;
    let size: number;
    try {
      size = JSON.stringify(args)?.length ?? 0;
    } catch {
      throw new Error('通知操作参数无效');
    }
    if (size > NOTIFICATION_ARGS_MAX) throw new Error('通知操作参数无效');
  }
  return { label, command: { id, ...(args !== undefined ? { args } : {}) } };
}

/** IPC-boundary validation for the Windows application-menu popup anchor. */
function validateAppMenuPosition(value: unknown): { x: number; y: number } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isBoundedPlainObject(value)) throw new Error('菜单位置无效');
  const x = value.x;
  const y = value.y;
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
    throw new Error('菜单位置无效');
  }
  return { x, y };
}

export class ShellWindowController {
  readonly window: BrowserWindow;
  private page: ShellPage;
  private readonly getPreferences: () => Promise<DesktopPreferences>;
  private readonly onPageChanged: ((page: ShellPage) => void) | undefined;

  private constructor(
    window: BrowserWindow,
    private readonly appVersion: string,
    getPreferences: () => Promise<DesktopPreferences>,
    initialPage: ShellPage,
    onPageChanged?: (page: ShellPage) => void,
  ) {
    this.window = window;
    this.getPreferences = getPreferences;
    this.page = initialPage;
    this.onPageChanged = onPageChanged;
  }

  static async create(options: ShellWindowOptions): Promise<ShellWindowController> {
    const initialPage = options.initialPage ?? 'session';
    const windowOptions: BrowserWindowConstructorOptions = {
      width: 1280,
      height: 800,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: formatShellWindowTitle(initialPage, options.appVersion, !app.isPackaged),
      backgroundColor: options.backgroundColor,
      ...platformWindowChrome(process.platform, options.titleBarOverlay),
      ...(options.icon ? { icon: options.icon } : {}),
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        additionalArguments: options.additionalArguments,
      },
    };
    const win = new BrowserWindow(windowOptions);
    if (process.platform === 'win32') {
      // Hide the native menu bar but keep the application menu so its
      // accelerators (Ctrl+Q, Ctrl+Shift+U, edit and zoom roles) stay live.
      // `setAutoHideMenuBar(false)` stops Alt from re-showing the bar.
      win.setMenuBarVisibility(false);
      win.setAutoHideMenuBar(false);
    }
    console.info('[wrenyard-desktop] shell window created');
    const controller = new ShellWindowController(
      win,
      options.appVersion,
      options.getPreferences,
      initialPage,
      options.onPageChanged,
    );
    controller.installSecurity(options.pageLoader.url('shell'));
    controller.installIpc(options);
    controller.installShortcuts(win.webContents);

    win.on('page-title-updated', (event) => event.preventDefault());
    win.on('closed', () => controller.removeIpcHandlers());
    // macOS hides the traffic lights in fullscreen; the renderer shrinks the
    // title bar reserve when it learns the state changed.
    win.on('enter-full-screen', () => controller.notifyWindowStateChanged(true));
    win.on('leave-full-screen', () => controller.notifyWindowStateChanged(false));
    // Trackpad swipe reports the gesture direction; mouse side buttons arrive
    // as app-command. Both dispatch the shared nav commands in the renderer.
    win.on('swipe', (_event, direction) => {
      if (direction === 'left') controller.deliverNavCommand('nav.back');
      else if (direction === 'right') controller.deliverNavCommand('nav.forward');
    });
    win.on('app-command', (_event, command) => {
      if (command === 'browser-backward') controller.deliverNavCommand('nav.back');
      else if (command === 'browser-forward') controller.deliverNavCommand('nav.forward');
    });

    options.onCreated?.(controller);
    win.webContents.on('did-finish-load', () => controller.setPage(controller.page, false));
    await options.pageLoader.load(win, 'shell');
    if (!options.smoke) win.show();
    console.info(`[wrenyard-desktop] shell loaded (visible=${win.isVisible()})`);
    return controller;
  }

  get currentPage(): ShellPage {
    return this.page;
  }

  setPage(page: ShellPage, focus = true): void {
    const changed = page !== this.page;
    this.page = page;
    this.window.setTitle(formatShellWindowTitle(page, this.appVersion, !app.isPackaged));
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.viewChanged, page);
      if (focus) this.window.webContents.focus();
    }
    if (changed) this.onPageChanged?.(page);
  }

  notifyQuotaChanged(): void {
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.quotaChanged);
    }
  }

  notifyUpdateChanged(): void {
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.updateChanged);
    }
  }

  notifyAppearanceChanged(appearance: ResolvedAppearance): void {
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.appearanceChanged, appearance);
    }
  }

  notifyNotificationsChanged(): void {
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.notificationsChanged);
    }
  }

  /** Push a changed activity projection to the status bar (content changes only). */
  notifyActivityChanged(snapshot: ActivityStatusSnapshot): void {
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.activityChanged, snapshot);
    }
  }

  /** Push a fresh preference snapshot to the renderer. */
  notifyPreferencesChanged(): void {
    if (this.window.webContents.isDestroyed()) return;
    void this.getPreferences().then((preferences) => {
      if (!this.window.webContents.isDestroyed()) {
        this.window.webContents.send(SHELL_CHANNELS.preferencesChanged, preferences);
      }
    }).catch(() => undefined);
  }

  /** Deliver a main-process command action (e.g. a native-notification click). */
  deliverCommandAction(action: NotificationCommandAction): void {
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.commandAction, action);
    }
  }

  /** Run a navigation command in the renderer command table. */
  deliverNavCommand(id: 'nav.back' | 'nav.forward'): void {
    this.deliverCommandAction({ id });
  }

  notifyWindowStateChanged(fullscreen: boolean): void {
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.windowStateChanged, { fullscreen });
    }
  }

  /**
   * Pop the application menu as a native menu (Windows). The anchor is the
   * button's bottom-left in renderer coordinates; the lone-Alt fallback uses
   * the button's fixed position.
   */
  private popupAppMenu(position?: { x: number; y: number }): void {
    const menu = Menu.getApplicationMenu();
    if (!menu || this.window.isDestroyed()) return;
    const anchor = position ?? { x: 8, y: TITLE_BAR_HEIGHT };
    menu.popup({ window: this.window, x: Math.round(anchor.x), y: Math.round(anchor.y) });
  }

  private installIpc(options: ShellWindowOptions): void {
    const assertShellSender = (sender: WebContents): void => {
      if (sender.id !== this.window.webContents.id) throw new Error('Untrusted shell IPC sender');
    };
    this.removeIpcHandlers();
    ipcMain.handle(SHELL_CHANNELS.navigate, async (event, page: unknown) => {
      assertShellSender(event.sender);
      if (!isShellPage(page)) throw new Error('Unsupported shell page');
      this.setPage(page);
    });
    ipcMain.handle(SHELL_CHANNELS.appearanceSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getAppearance();
    });
    ipcMain.handle(SHELL_CHANNELS.settingsSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getSettings();
    });
    ipcMain.handle(SHELL_CHANNELS.statsSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getStats();
    });
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
    ipcMain.handle(SHELL_CHANNELS.openProviderKeyPage, async (event, providerId: unknown) => {
      assertShellSender(event.sender);
      const url = providerKeyPageUrl(providerId);
      if (url === null) throw new Error('不支持的 Provider 密钥页面');
      await shell.openExternal(url);
    });
    ipcMain.handle(SHELL_CHANNELS.updateSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getUpdate();
    });
    ipcMain.handle(SHELL_CHANNELS.checkUpdate, async (event) => {
      assertShellSender(event.sender);
      return options.checkUpdate();
    });
    ipcMain.handle(SHELL_CHANNELS.requestInstall, async (event) => {
      assertShellSender(event.sender);
      return options.requestInstall();
    });
    ipcMain.handle(SHELL_CHANNELS.savePetSettings, async (event, settings: PetCompanionSettings) => {
      assertShellSender(event.sender);
      return options.savePetSettings(settings);
    });
    ipcMain.handle(SHELL_CHANNELS.saveWorkspace, async (event, path: unknown, create: unknown) => {
      assertShellSender(event.sender);
      if (typeof path !== 'string' || path.length > 4_096) throw new Error('Workspace 路径无效');
      if (create !== undefined && create !== null && typeof create !== 'boolean') throw new Error('Workspace 创建参数无效');
      return options.saveWorkspace(path, create === true);
    });
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
    ipcMain.handle(SHELL_CHANNELS.taskTranscript, async (event, taskRunId: unknown) => {
      assertShellSender(event.sender);
      if (typeof taskRunId !== 'string' || !/^task_[a-zA-Z0-9_-]{1,128}$/.test(taskRunId)) {
        throw new Error('任务运行 id 无效');
      }
      return options.openTaskTranscript(taskRunId);
    });
    ipcMain.handle(SHELL_CHANNELS.taskGraph, async (event, taskGraphId: unknown) => {
      assertShellSender(event.sender);
      if (typeof taskGraphId !== 'string' || taskGraphId.length === 0 || taskGraphId.length > 256) {
        throw new Error('任务图 id 无效');
      }
      return options.openTaskGraph(taskGraphId);
    });
    ipcMain.handle(SHELL_CHANNELS.taskSettingsSnapshot, async (event, project: unknown, taskId: unknown) => {
      assertShellSender(event.sender);
      const boundedProject = boundedOptionalProject(project);
      if (taskId !== undefined && taskId !== null) {
        if (typeof taskId !== 'string' || !taskId || taskId.length > 512) throw new Error('任务 id 无效');
      }
      return options.getTaskSettings(
        boundedProject,
        taskId === undefined || taskId === null ? undefined : taskId,
      );
    });
    ipcMain.handle(SHELL_CHANNELS.taskSettingsSave, async (event, request: unknown) => {
      assertShellSender(event.sender);
      return options.saveTaskSettings(validateTaskSettingsSaveRequest(request));
    });
    ipcMain.handle(SHELL_CHANNELS.runtimeAliasSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.runtimeAliasSnapshot();
    });
    ipcMain.handle(SHELL_CHANNELS.runtimeAliasPut, async (event, request: unknown) => {
      assertShellSender(event.sender);
      return options.runtimeAliasPut(validateRuntimeAliasPutRequest(request));
    });
    ipcMain.handle(SHELL_CHANNELS.runtimeAliasRemove, async (event, request: unknown) => {
      assertShellSender(event.sender);
      return options.runtimeAliasRemove(validateRuntimeAliasRemoveRequest(request));
    });
    ipcMain.handle(SHELL_CHANNELS.taskRoutingTest, async (event, params: unknown) => {
      assertShellSender(event.sender);
      return options.requestTaskRoutingTest(validateTaskRoutingTestParams(params));
    });
    ipcMain.handle(SHELL_CHANNELS.taskRoutingTestTasks, async (event) => {
      assertShellSender(event.sender);
      return options.requestRoutingTestTasks();
    });
    ipcMain.handle(SHELL_CHANNELS.summaryModelSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getSummarySettings();
    });
    ipcMain.handle(SHELL_CHANNELS.summaryModelSave, async (event, canonicalModel: unknown) => {
      assertShellSender(event.sender);
      if (typeof canonicalModel !== 'string' || !canonicalModel || canonicalModel.length > 256
        || TASK_SETTINGS_CONTROL_CHARS.test(canonicalModel)) {
        throw new Error('摘要模型无效');
      }
      return options.saveSummaryModel(canonicalModel);
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
    ipcMain.handle(SHELL_CHANNELS.notificationsSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getNotifications();
    });
    ipcMain.handle(SHELL_CHANNELS.notificationNotify, async (event, input: unknown) => {
      assertShellSender(event.sender);
      return options.notify(validateNotificationInput(input));
    });
    ipcMain.handle(SHELL_CHANNELS.notificationDismiss, async (event, id: unknown) => {
      assertShellSender(event.sender);
      if (!isBoundedString(id, NOTIFICATION_ID_MAX)) throw new Error('通知 id 无效');
      return options.dismissNotification(id);
    });
    ipcMain.handle(SHELL_CHANNELS.notificationsClear, async (event) => {
      assertShellSender(event.sender);
      return options.clearNotifications();
    });
    ipcMain.handle(SHELL_CHANNELS.notificationsMarkRead, async (event) => {
      assertShellSender(event.sender);
      return options.markNotificationsRead();
    });
    ipcMain.handle(SHELL_CHANNELS.notificationsSetDoNotDisturb, async (event, value: unknown) => {
      assertShellSender(event.sender);
      if (typeof value !== 'boolean') throw new Error('勿扰参数无效');
      return options.setDoNotDisturb(value);
    });
    ipcMain.handle(SHELL_CHANNELS.preferencesSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getPreferences();
    });
    ipcMain.handle(SHELL_CHANNELS.setPreference, async (event, id: unknown, value: unknown) => {
      assertShellSender(event.sender);
      if (!isPreferenceId(id)) throw new Error('未知偏好');
      return options.setPreference(id, value);
    });
    ipcMain.handle(SHELL_CHANNELS.activityStatusSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getActivityStatus();
    });
    ipcMain.handle(SHELL_CHANNELS.openSettingsFile, async (event) => {
      assertShellSender(event.sender);
      return options.openSettingsFile();
    });
    ipcMain.handle(SHELL_CHANNELS.openLogsDirectory, async (event) => {
      assertShellSender(event.sender);
      return options.openLogsDirectory();
    });
    ipcMain.handle(SHELL_CHANNELS.revealWorkspace, async (event, path: unknown) => {
      assertShellSender(event.sender);
      if (typeof path !== 'string' || path.length === 0 || path.length > 4_096) throw new Error('工作区路径无效');
      return options.revealWorkspace(path);
    });
  }

  private removeIpcHandlers(): void {
    for (const channel of [
      SHELL_CHANNELS.navigate,
      SHELL_CHANNELS.showAppMenu,
      SHELL_CHANNELS.appearanceSnapshot,
      SHELL_CHANNELS.settingsSnapshot,
      SHELL_CHANNELS.statsSnapshot,
      SHELL_CHANNELS.quotaSnapshot,
      SHELL_CHANNELS.saveProviderOrder,
      SHELL_CHANNELS.configureProviderKey,
      SHELL_CHANNELS.openProviderKeyPage,
      SHELL_CHANNELS.updateSnapshot,
      SHELL_CHANNELS.checkUpdate,
      SHELL_CHANNELS.requestInstall,
      SHELL_CHANNELS.savePetSettings,
      SHELL_CHANNELS.saveWorkspace,
      SHELL_CHANNELS.taskTranscript,
      SHELL_CHANNELS.taskGraph,
      SHELL_CHANNELS.openExternal,
      SHELL_CHANNELS.taskSettingsSnapshot,
      SHELL_CHANNELS.taskSettingsSave,
      SHELL_CHANNELS.runtimeAliasSnapshot,
      SHELL_CHANNELS.runtimeAliasPut,
      SHELL_CHANNELS.runtimeAliasRemove,
      SHELL_CHANNELS.taskRoutingTest,
      SHELL_CHANNELS.taskRoutingTestTasks,
      SHELL_CHANNELS.summaryModelSnapshot,
      SHELL_CHANNELS.summaryModelSave,
      SHELL_CHANNELS.execStart,
      SHELL_CHANNELS.execGet,
      SHELL_CHANNELS.execEvents,
      SHELL_CHANNELS.execCancel,
      SHELL_CHANNELS.notificationsSnapshot,
      SHELL_CHANNELS.notificationNotify,
      SHELL_CHANNELS.notificationDismiss,
      SHELL_CHANNELS.notificationsClear,
      SHELL_CHANNELS.notificationsMarkRead,
      SHELL_CHANNELS.notificationsSetDoNotDisturb,
      SHELL_CHANNELS.preferencesSnapshot,
      SHELL_CHANNELS.setPreference,
      SHELL_CHANNELS.activityStatusSnapshot,
      SHELL_CHANNELS.openSettingsFile,
      SHELL_CHANNELS.openLogsDirectory,
      SHELL_CHANNELS.revealWorkspace,
    ]) ipcMain.removeHandler(channel);
  }

  private installShortcuts(contents: WebContents): void {
    // Windows keeps the Alt-tap menu habit: a lone Alt press/release pops the
    // application menu, while Alt combined with any other key is left alone.
    let altDown = false;
    let altUsed = false;
    contents.on('before-input-event', (event, input: Input) => {
      if (process.platform === 'win32' && input.key === 'Alt') {
        if (input.type === 'keyDown') {
          if (!altDown) {
            altDown = true;
            altUsed = false;
          }
        } else {
          if (altDown && !altUsed) {
            event.preventDefault();
            this.popupAppMenu();
          }
          altDown = false;
        }
        return;
      }
      if (input.type === 'keyUp') return;
      if (altDown) altUsed = true;
      const nav = navCommandForInput(input, process.platform);
      if (nav) {
        event.preventDefault();
        this.deliverNavCommand(nav);
        return;
      }
      const page = acceleratorPage(input, process.platform);
      if (!page) return;
      event.preventDefault();
      this.setPage(page);
    });
  }

  private installSecurity(rendererUrl: string): void {
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, targetUrl) => {
      if (targetUrl.split('#', 1)[0] !== rendererUrl) event.preventDefault();
    });
  }
}
