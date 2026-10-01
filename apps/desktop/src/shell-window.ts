import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  type BrowserWindowConstructorOptions,
  type Input,
  type WebContents,
} from 'electron';
import type { PageLoader } from './pages.js';
import {
  SHELL_CHANNELS,
  acceleratorPage,
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
import type { ShellIpcDeps } from './main/ipc/deps.js';
import { registerAppearancePreferencesIpc } from './main/ipc/appearance-preferences.js';
import { registerNavigationChromeIpc } from './main/ipc/navigation-chrome.js';
import { registerNotificationsIpc } from './main/ipc/notifications.js';
import { registerQuotaProvidersIpc } from './main/ipc/quota-providers.js';
import { registerSessionExecIpc } from './main/ipc/session-exec.js';
import { registerTasksStatsIpc } from './main/ipc/tasks-stats.js';
import { registerUpdateDaemonIpc } from './main/ipc/update-daemon.js';
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

export class ShellWindowController {
  readonly window: BrowserWindow;
  private page: ShellPage;
  /** Cleanups returned by the per-domain IPC registrars. */
  private ipcCleanups: Array<() => void> = [];
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
    const deps: ShellIpcDeps = {
      options,
      assertShellSender,
      setPage: (page, focus) => this.setPage(page, focus),
    };
    this.ipcCleanups = [
      registerAppearancePreferencesIpc(ipcMain, deps),
      registerNavigationChromeIpc(ipcMain, deps),
      registerNotificationsIpc(ipcMain, deps),
      registerQuotaProvidersIpc(ipcMain, deps),
      registerSessionExecIpc(ipcMain, deps),
      registerTasksStatsIpc(ipcMain, deps),
      registerUpdateDaemonIpc(ipcMain, deps),
    ];
  }

  private removeIpcHandlers(): void {
    for (const cleanup of this.ipcCleanups) cleanup();
    this.ipcCleanups = [];
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
