import {
  BrowserWindow,
  ipcMain,
  type BrowserWindowConstructorOptions,
  type Input,
  type WebContents,
} from 'electron';
import { pathToFileURL } from 'node:url';
import {
  SHELL_CHANNELS,
  acceleratorPage,
  isShellPage,
  type ConversationSnapshot,
  type StatsSnapshot,
  type QuotaSnapshot,
  type SettingsSnapshot,
  type PetCompanionSettings,
  type ShellPage,
  type WorkspaceConfigurationSnapshot,
  type UpdateChannel,
  type UpdateSnapshot,
  type TaskSettingsSaveRequest,
  type TaskSettingsSnapshot,
} from './shell-contract.js';
import type {
  ClientConfigurationDto,
  ClientConfigurationId,
  ClientConfigurationPlanDto,
  ClientConfigurationSnapshotDto,
  ClientModelSelectionDto,
} from './client-configuration/contract.js';
import { formatShellWindowTitle } from './shell-window-title.js';
import { platformWindowChrome } from './window-chrome.js';

export interface ShellWindowOptions {
  rendererPath: string;
  preloadPath: string;
  appVersion: string;
  smoke: boolean;
  icon?: string;
  getSettings(): Promise<SettingsSnapshot>;
  getStats(): Promise<StatsSnapshot>;
  getQuota(forceRefresh?: boolean): Promise<QuotaSnapshot>;
  saveProviderOrder(providerIds: string[]): Promise<QuotaSnapshot>;
  configureProviderKey(providerId: string, key: string): Promise<QuotaSnapshot>;
  getClientConfiguration(): Promise<ClientConfigurationSnapshotDto>;
  planClientConfiguration(clientId: ClientConfigurationId, selection: ClientModelSelectionDto): Promise<ClientConfigurationPlanDto>;
  applyClientConfiguration(plan: ClientConfigurationPlanDto): Promise<ClientConfigurationDto>;
  planClientConfigurationRestore(clientId: ClientConfigurationId): Promise<ClientConfigurationPlanDto>;
  restoreClientConfiguration(plan: ClientConfigurationPlanDto): Promise<ClientConfigurationDto>;
  getUpdate(): Promise<UpdateSnapshot>;
  checkUpdate(): Promise<UpdateSnapshot>;
  setUpdateChannel(channel: UpdateChannel): Promise<UpdateSnapshot>;
  requestInstall(onInstall?: () => void): Promise<UpdateSnapshot>;
  cancelPendingInstall(): Promise<UpdateSnapshot>;
  savePetSettings(settings: PetCompanionSettings): Promise<SettingsSnapshot>;
  saveWorkspace(path: string): Promise<WorkspaceConfigurationSnapshot>;
  getConversation(): Promise<ConversationSnapshot>;
  selectConversation(sessionId: string): Promise<ConversationSnapshot>;
  createConversation(): Promise<ConversationSnapshot>;
  selectConversationModel(provider: string, model: string): Promise<ConversationSnapshot>;
  sendConversation(text: string, clientTimeZone?: string): Promise<ConversationSnapshot>;
  cancelConversation(): Promise<ConversationSnapshot>;
  getTaskSettings(project?: string, taskId?: string): Promise<TaskSettingsSnapshot>;
  saveTaskSettings(request: TaskSettingsSaveRequest): Promise<TaskSettingsSnapshot>;
}

const TASK_SETTINGS_PATCH_KEYS = new Set(['mode', 'explicit_runtime', 'timeout_ms', 'additional_instructions', 'automatic']);
const TASK_SETTINGS_AUTOMATIC_KEYS = new Set([
  'expected_tps',
  'minimum_tps',
  'intelligence_min',
  'intelligence_max',
  'max_output_usd_per_million',
  'required_capabilities',
  'exclude_model_ids',
  'exclude_profile_ids',
  'exclude_client_ids',
  'exclude_provider_ids',
  'preferred_runtime',
]);
const TASK_SETTINGS_INTELLIGENCE_VALUES = new Set(['low', 'mid', 'high', 'frontier', 'premium']);
const TASK_SETTINGS_CAPABILITY_VALUES = new Set(['text', 'image']);
const TASK_SETTINGS_EXPLICIT_FIELDS = ['client', 'provider', 'model'] as const;
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

function validateExplicitRuntimeValue(explicitRuntime: unknown): void {
  if (explicitRuntime === undefined || explicitRuntime === null) return;
  if (!isBoundedPlainObject(explicitRuntime)) throw new Error('显式运行时无效');
  for (const field of Object.keys(explicitRuntime)) {
    if (field !== 'client' && field !== 'provider' && field !== 'model') throw new Error('显式运行时无效');
  }
  for (const field of TASK_SETTINGS_EXPLICIT_FIELDS) {
    const fieldValue = explicitRuntime[field];
    if (typeof fieldValue !== 'string' || !fieldValue || fieldValue.length > TASK_SETTINGS_STRING_MAX) {
      throw new Error('显式运行时无效');
    }
  }
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
  for (const field of ['intelligence_min', 'intelligence_max'] as const) {
    const value = automatic[field];
    if (allowFieldReset && value === null) continue;
    if (value !== undefined && (typeof value !== 'string' || !TASK_SETTINGS_INTELLIGENCE_VALUES.has(value))) {
      throw new Error('自动约束无效');
    }
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
  if (automatic.preferred_runtime !== undefined && !(allowFieldReset && automatic.preferred_runtime === null)) validateExplicitRuntimeValue(automatic.preferred_runtime);
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
  const mode = patch.mode;
  if (mode !== undefined && mode !== null && mode !== 'automatic' && mode !== 'explicit') throw new Error('运行时模式无效');
  validateExplicitRuntimeValue(patch.explicit_runtime);
  const timeoutMs = patch.timeout_ms;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('超时设置无效');
  }
  const additionalInstructions = patch.additional_instructions;
  if (additionalInstructions !== undefined && additionalInstructions !== null) {
    if (typeof additionalInstructions !== 'string'
      || additionalInstructions.length > 4_000
      || TASK_SETTINGS_CONTROL_CHARS.test(additionalInstructions)) {
      throw new Error('附加说明无效');
    }
  }
  validateAutomaticDispatch(patch.automatic, true);
  const request: TaskSettingsSaveRequest = {
    scope,
    expected_revision: expectedRevision,
    patch: patch as unknown as TaskSettingsSaveRequest['patch'],
  };
  if (taskId !== undefined && taskId !== null) request.task_id = taskId;
  if (project !== undefined) request.project = project;
  return request;
}

export class ShellWindowController {
  readonly window: BrowserWindow;
  private page: ShellPage = 'workbench';

  private constructor(window: BrowserWindow, private readonly appVersion: string) {
    this.window = window;
  }

  static async create(options: ShellWindowOptions): Promise<ShellWindowController> {
    const windowOptions: BrowserWindowConstructorOptions = {
      width: 1280,
      height: 800,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: formatShellWindowTitle('workbench', options.appVersion),
      backgroundColor: '#f7efd8',
      ...platformWindowChrome(process.platform),
      ...(options.icon ? { icon: options.icon } : {}),
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
      },
    };
    const win = new BrowserWindow(windowOptions);
    const controller = new ShellWindowController(win, options.appVersion);
    controller.installSecurity(options.rendererPath);
    controller.installIpc(options);
    controller.installShortcuts(win.webContents);

    win.on('page-title-updated', (event) => event.preventDefault());
    win.on('closed', () => controller.removeIpcHandlers());

    await win.loadFile(options.rendererPath);
    controller.setPage('workbench', false);
    if (!options.smoke) win.show();
    return controller;
  }

  get currentPage(): ShellPage {
    return this.page;
  }

  setPage(page: ShellPage, focus = true): void {
    this.page = page;
    this.window.setTitle(formatShellWindowTitle(page, this.appVersion));
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.viewChanged, page);
      if (focus) this.window.webContents.focus();
    }
  }

  notifyConversationChanged(): void {
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.send(SHELL_CHANNELS.conversationChanged);
    }
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
    ipcMain.handle(SHELL_CHANNELS.clientConfigurationSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getClientConfiguration();
    });
    ipcMain.handle(SHELL_CHANNELS.clientConfigurationPlan, async (event, clientId: ClientConfigurationId, selection: ClientModelSelectionDto) => {
      assertShellSender(event.sender);
      return options.planClientConfiguration(clientId, selection);
    });
    ipcMain.handle(SHELL_CHANNELS.clientConfigurationApply, async (event, plan: ClientConfigurationPlanDto) => {
      assertShellSender(event.sender);
      return options.applyClientConfiguration(plan);
    });
    ipcMain.handle(SHELL_CHANNELS.clientConfigurationPlanRestore, async (event, clientId: ClientConfigurationId) => {
      assertShellSender(event.sender);
      return options.planClientConfigurationRestore(clientId);
    });
    ipcMain.handle(SHELL_CHANNELS.clientConfigurationRestore, async (event, plan: ClientConfigurationPlanDto) => {
      assertShellSender(event.sender);
      return options.restoreClientConfiguration(plan);
    });
    ipcMain.handle(SHELL_CHANNELS.updateSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getUpdate();
    });
    ipcMain.handle(SHELL_CHANNELS.checkUpdate, async (event) => {
      assertShellSender(event.sender);
      return options.checkUpdate();
    });
    ipcMain.handle(SHELL_CHANNELS.setUpdateChannel, async (event, channel: unknown) => {
      assertShellSender(event.sender);
      if (channel !== 'stable' && channel !== 'dev') throw new Error('更新通道无效');
      return options.setUpdateChannel(channel);
    });
    ipcMain.handle(SHELL_CHANNELS.requestInstall, async (event) => {
      assertShellSender(event.sender);
      return options.requestInstall();
    });
    ipcMain.handle(SHELL_CHANNELS.cancelPendingInstall, async (event) => {
      assertShellSender(event.sender);
      return options.cancelPendingInstall();
    });
    ipcMain.handle(SHELL_CHANNELS.savePetSettings, async (event, settings: PetCompanionSettings) => {
      assertShellSender(event.sender);
      return options.savePetSettings(settings);
    });
    ipcMain.handle(SHELL_CHANNELS.saveWorkspace, async (event, path: unknown) => {
      assertShellSender(event.sender);
      if (typeof path !== 'string' || path.length > 4_096) throw new Error('Workspace 路径无效');
      return options.saveWorkspace(path);
    });
    ipcMain.handle(SHELL_CHANNELS.conversationSnapshot, async (event) => {
      assertShellSender(event.sender);
      return options.getConversation();
    });
    ipcMain.handle(SHELL_CHANNELS.conversationSelect, async (event, sessionId: unknown) => {
      assertShellSender(event.sender);
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('会话 id 无效');
      return options.selectConversation(sessionId);
    });
    ipcMain.handle(SHELL_CHANNELS.conversationCreate, async (event) => {
      assertShellSender(event.sender);
      return options.createConversation();
    });
    ipcMain.handle(SHELL_CHANNELS.conversationSelectModel, async (event, provider: unknown, model: unknown) => {
      assertShellSender(event.sender);
      if (typeof provider !== 'string' || !provider || provider.length > 256) throw new Error('模型 provider 无效');
      if (typeof model !== 'string' || !model || model.length > 512) throw new Error('模型 id 无效');
      return options.selectConversationModel(provider, model);
    });
    ipcMain.handle(SHELL_CHANNELS.conversationSend, async (event, text: unknown, clientTimeZone: unknown) => {
      assertShellSender(event.sender);
      if (typeof text !== 'string') throw new Error('消息格式无效');
      if (clientTimeZone !== undefined && typeof clientTimeZone !== 'string') throw new Error('时区格式无效');
      return options.sendConversation(text, clientTimeZone);
    });
    ipcMain.handle(SHELL_CHANNELS.conversationCancel, async (event) => {
      assertShellSender(event.sender);
      return options.cancelConversation();
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
  }

  private removeIpcHandlers(): void {
    for (const channel of [
      SHELL_CHANNELS.navigate,
      SHELL_CHANNELS.settingsSnapshot,
      SHELL_CHANNELS.statsSnapshot,
      SHELL_CHANNELS.quotaSnapshot,
      SHELL_CHANNELS.saveProviderOrder,
      SHELL_CHANNELS.configureProviderKey,
      SHELL_CHANNELS.clientConfigurationSnapshot,
      SHELL_CHANNELS.clientConfigurationPlan,
      SHELL_CHANNELS.clientConfigurationApply,
      SHELL_CHANNELS.clientConfigurationPlanRestore,
      SHELL_CHANNELS.clientConfigurationRestore,
      SHELL_CHANNELS.updateSnapshot,
      SHELL_CHANNELS.checkUpdate,
      SHELL_CHANNELS.setUpdateChannel,
      SHELL_CHANNELS.requestInstall,
      SHELL_CHANNELS.cancelPendingInstall,
      SHELL_CHANNELS.savePetSettings,
      SHELL_CHANNELS.saveWorkspace,
      SHELL_CHANNELS.conversationSnapshot,
      SHELL_CHANNELS.conversationSelect,
      SHELL_CHANNELS.conversationCreate,
      SHELL_CHANNELS.conversationSelectModel,
      SHELL_CHANNELS.conversationSend,
      SHELL_CHANNELS.conversationCancel,
      SHELL_CHANNELS.taskSettingsSnapshot,
      SHELL_CHANNELS.taskSettingsSave,
    ]) ipcMain.removeHandler(channel);
  }

  private installShortcuts(contents: WebContents): void {
    contents.on('before-input-event', (event, input: Input) => {
      const page = acceleratorPage(input, process.platform);
      if (!page) return;
      event.preventDefault();
      this.setPage(page);
    });
  }

  private installSecurity(rendererPath: string): void {
    const rendererUrl = pathToFileURL(rendererPath).href;
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, targetUrl) => {
      if (targetUrl.split('#', 1)[0] !== rendererUrl) event.preventDefault();
    });
  }
}
