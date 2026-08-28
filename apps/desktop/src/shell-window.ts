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
} from './shell-contract.js';

const PRODUCT_TITLE = '啾啾工坊';

export interface ShellWindowOptions {
  rendererPath: string;
  preloadPath: string;
  smoke: boolean;
  icon?: string;
  getSettings(): Promise<SettingsSnapshot>;
  getStats(): Promise<StatsSnapshot>;
  getQuota(forceRefresh?: boolean): Promise<QuotaSnapshot>;
  savePetSettings(settings: PetCompanionSettings): Promise<SettingsSnapshot>;
  saveWorkspace(path: string): Promise<WorkspaceConfigurationSnapshot>;
  getConversation(): Promise<ConversationSnapshot>;
  selectConversation(sessionId: string): Promise<ConversationSnapshot>;
  createConversation(): Promise<ConversationSnapshot>;
  sendConversation(text: string, clientTimeZone?: string): Promise<ConversationSnapshot>;
  cancelConversation(): Promise<ConversationSnapshot>;
}

export class ShellWindowController {
  readonly window: BrowserWindow;
  private page: ShellPage = 'workbench';

  private constructor(window: BrowserWindow) {
    this.window = window;
  }

  static async create(options: ShellWindowOptions): Promise<ShellWindowController> {
    const windowOptions: BrowserWindowConstructorOptions = {
      width: 1280,
      height: 800,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: PRODUCT_TITLE,
      backgroundColor: '#f7efd8',
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
    const controller = new ShellWindowController(win);
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
    const pageTitle = page === 'stats' ? '工房台账' : page === 'quota' ? '额度' : '设置';
    this.window.setTitle(page === 'workbench' ? PRODUCT_TITLE : `${pageTitle} — ${PRODUCT_TITLE}`);
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
  }

  private removeIpcHandlers(): void {
    for (const channel of [
      SHELL_CHANNELS.navigate,
      SHELL_CHANNELS.settingsSnapshot,
      SHELL_CHANNELS.statsSnapshot,
      SHELL_CHANNELS.quotaSnapshot,
      SHELL_CHANNELS.savePetSettings,
      SHELL_CHANNELS.saveWorkspace,
      SHELL_CHANNELS.conversationSnapshot,
      SHELL_CHANNELS.conversationSelect,
      SHELL_CHANNELS.conversationCreate,
      SHELL_CHANNELS.conversationSend,
      SHELL_CHANNELS.conversationCancel,
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
