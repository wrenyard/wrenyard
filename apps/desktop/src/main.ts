import { app, BrowserWindow, dialog, ipcMain, Menu, Notification as ElectronNotification, powerMonitor, screen, session, type MessageBoxOptions } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WrenyardIpcClient, resolveWrenyardIpcPath, WrenyardRpcError, type WrenyardGatewayConnection } from '@wrenyard/control-client';
import { registerSession, type SessionRegistration } from './session/ipc.js';
import { DesktopPetRuntime } from './pet/main/runtime.js';
import { createDesktopTray, type DesktopTrayHandle } from './desktop-tray.js';
import { ensureDesktopActivationPolicy } from './desktop-activation-policy.js';
import { DesktopPetController } from './pet-controller.js';
import { DesktopSettingsStore } from './main/settings/desktop-settings.js';
import { DesktopAppearanceController } from './main/appearance.js';
import { WrenyardDaemonClient } from './main/daemon-client/client.js';
import { DaemonSubscriptions } from './main/daemon-client/subscriptions.js';
import { reorderProviders } from './provider-order.js';
import { TaskGraphWindowOwner } from './main/windows/taskgraph-windows.js';
import { DesktopQuotaController } from './quota-controller.js';
import { DesktopQuotaSource } from './quota-service.js';
import { ProviderService } from './provider-service.js';
import { buildSettingsSnapshot, type HealthSnapshot } from './settings-snapshot.js';
import { readStatsSnapshot } from './stats-snapshot.js';
import { SHELL_CHANNELS, isSettingsLaunchRequest, type DaemonLifecycleSnapshot, type ExecEventsRequest, type ExecEventsResult, type ExecSnapshotDto, type ExecStartRequest, type PetCompanionSettings, type RuntimeAliasPutRequest, type RuntimeAliasRemoveRequest, type RuntimeAliasSnapshot, type ShellPage, type SummarySettingsSnapshot, type TaskRoutingTestParams, type TaskRoutingTestResult, type TaskRoutingTestTasksResult, type TaskSettingsSaveRequest, type TaskSettingsSnapshot, type WorkspaceConfigurationSnapshot } from './shell-contract.js';
import { ShellWindowController } from './shell-window.js';
import { NotificationCenter, type NotificationInput, type ShellNotification } from './main/notification-center.js';
import { DesktopUpdateController } from './updater/controller.js';
import { DesktopDaemonSupervisor } from './daemon-supervisor.js';
import { probeWrenyard as probeDaemon } from './daemon-health.js';
import { createPageLoader, preloadPath } from './pages.js';
import { createQuitController, type QuitController, type QuitCounts, type QuitDialogHandle } from './quit-controller.js';
import { resolveDesktopBuildTime } from './build-metadata.js';
import { desktopMenuTemplate } from './app-menu.js';
import { packagedDaemonLaunch } from '../../daemon/lib/daemon/launch.mts';
import { resolveForemanConfigPath } from '../../daemon/lib/config/path.mts';
import { foremanStateRoot } from '../../daemon/lib/config/state.mts';
import {
  createMacQuitConfirmationGate,
  type QuitOrigin,
} from './desktop-interaction-policy.js';
import {
  createProductWorkspace,
  inspectProductWorkspace,
  saveProductWorkspace,
} from './workspace.js';
import { assertDaemonIdle, restartOwnedDaemon } from './workspace-activation.js';

const SMOKE = process.env.WRENYARD_DESKTOP_SMOKE === '1' || process.argv.includes('--smoke');
const FOREMAN_HEALTH_TIMEOUT_MS = 5_000;
/** Task definition enumeration may cold-load the workspace and model catalog. */
const TASK_SETTINGS_REQUEST_TIMEOUT_MS = 30_000;
const TASK_SETTINGS_SAVE_ERROR_MESSAGES: Record<string, string> = {
  content_conflict: '任务设置已被外部修改，保存冲突',
  invalid_settings: '任务设置内容无效',
  runtime_unavailable: '所选 Agent 运行时不可用',
  task_not_found: '任务不存在或已被移除',
};
const RUNTIME_ALIAS_ERROR_MESSAGES: Record<string, string> = {
  content_conflict: '运行时别名已被外部修改，保存冲突',
  invalid_name: '运行时别名格式无效',
  invalid_target: '运行时目标无效',
  alias_not_found: '运行时别名不存在',
};
/** Smoke drives task enumeration and a routing test over IPC, which can cold-load the workspace and model catalog. */
const SMOKE_TIMEOUT_MS = 90_000;
/** Bounded settle budget: React mounts/activates the target page asynchronously after `setPage`. */
const SMOKE_PAGE_VISIBILITY_TIMEOUT_MS = 10_000;

/** Read the bounded public health projection from the given IPC socket. */
async function readWrenyardHealth(path: string): Promise<HealthSnapshot> {
  let client: WrenyardIpcClient | null = null;
  try {
    client = new WrenyardIpcClient({ path, requestTimeoutMs: FOREMAN_HEALTH_TIMEOUT_MS });
    const result: unknown = await client.request('health.ping');
    if (result != null && typeof result === 'object') {
      if ('ok' in result && result.ok === false) return { connected: false };
      const uptimeMs = 'uptimeMs' in result && typeof result.uptimeMs === 'number'
        ? result.uptimeMs
        : undefined;
      return { connected: true, ...(uptimeMs !== undefined ? { uptimeMs } : {}) };
    }
    return { connected: true };
  } catch {
    return { connected: false };
  } finally {
    await client?.close?.();
  }
}

const probeWrenyard = (path: string) => probeDaemon(path, app.getVersion());

/** Waits until a shut-down source daemon went away and a compatible one answers again. */
async function waitForSourceDaemonRestart(path: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let wentAway = false;
  while (Date.now() < deadline) {
    const probe = await probeWrenyard(path);
    if (!probe.connected) wentAway = true;
    else if (wentAway && probe.compatible) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error('daemon 未在工作区切换后重新启动，请检查 daemon 的 dev 终端');
}

async function readGatewayConnection(path: string): Promise<WrenyardGatewayConnection> {
  const client = new WrenyardIpcClient({ path, requestTimeoutMs: FOREMAN_HEALTH_TIMEOUT_MS });
  try { return await client.gatewayConnection(); } finally { client.close(); }
}

function resolveAppIcon(): string | undefined {
  const packaged = join(process.resourcesPath, 'icon.png');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  const fromApp = join(app.getAppPath(), 'resources', 'icon.png');
  return existsSync(fromApp) ? fromApp : undefined;
}

/**
 * Absolute path of the running app bundle / executable for the platform
 * applier. `app.getAppPath()` resolves to the bundled asar, not the `.app`
 * bundle, so macOS walks up from the native executable
 * (`.../Contents/MacOS/name`); Windows uses the executable itself.
 */
function resolveUpdateAppPath(): string {
  return process.platform === 'darwin'
    ? dirname(dirname(dirname(process.execPath)))
    : process.execPath;
}

function resolvePetAssets(): { preloadDir: string } {
  return { preloadDir: join(app.getAppPath(), 'dist', 'preload') };
}

/**
 * Wait until the `[data-page]` React root that owns the given shell page is
 * mounted and actually visible. Pages mount on first visit and are then kept
 * alive off-screen, so existence alone is not enough: the root must have a
 * non-zero box (`getBoundingClientRect`) and a non-`none` display /
 * non-`hidden` visibility. Polls within a bound while React activation
 * settles; never resolves to true for a hidden kept-alive page.
 */
async function waitForVisiblePageRoot(shell: ShellWindowController, page: ShellPage): Promise<boolean> {
  const expression = `(() => {
    const root = document.querySelector(${JSON.stringify(`[data-page=${JSON.stringify(page)}]`)});
    if (!(root instanceof HTMLElement)) return false;
    const style = getComputedStyle(root);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = root.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`;
  const deadline = Date.now() + SMOKE_PAGE_VISIBILITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const visible = await shell.window.webContents.executeJavaScript(expression);
    if (visible === true) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

async function runSmoke(shell: ShellWindowController): Promise<void> {
  const check = async (): Promise<void> => {
    const [shellOk, snapshotOk, quotaOk] = await Promise.all([
      shell.window.webContents.executeJavaScript(
        "document.body?.innerText.includes('啾啾工坊设置') === true",
      ),
      shell.window.webContents.executeJavaScript(
        "window.wrenyardShell.getSettings().then((value) => value?.service?.status === 'connected' && value?.pet?.settings?.entities && Array.isArray(value?.pet?.settings?.quota?.providers) && typeof value?.update?.currentVersion === 'string' && typeof value?.update?.installSupported === 'boolean').catch(() => false)",
      ),
      shell.window.webContents.executeJavaScript(
        "window.wrenyardShell.getQuota().then((value) => (value?.status === 'available' || value?.status === 'unavailable') && Array.isArray(value?.providers) && Array.isArray(value?.catalog) && value.providers.every((provider) => value.catalog.some((entry) => entry.id === provider.id && entry.configured === true && entry.quota))).catch(() => false)",
      ),
    ]);
    // Task settings/definitions over real IPC: rows, persisted layers, aliases
    // and daemon-owned effective settings must all be present and well typed.
    const tasksOk = await shell.window.webContents.executeJavaScript(
      "window.wrenyardShell.getTaskSettings().then((value) => value && typeof value.revision === 'string' && typeof value.config_path === 'string' && value.user_global && typeof value.user_global === 'object' && !Array.isArray(value.user_global) && Array.isArray(value.rows) && value.rows.length > 0 && value.rows.every((row) => typeof row.identity === 'string' && typeof row.name === 'string' && typeof row.display_name === 'string' && row.user_task && row.effective && Array.isArray(row.issues)) && Array.isArray(value.aliases)).catch(() => false)",
    );
    // Read-only routing test surfaces: the import list of task definitions and
    // the daemon-scored routing test result must both be well typed.
    const routingOk = await shell.window.webContents.executeJavaScript(
      "Promise.all([window.wrenyardShell.requestRoutingTestTasks(), window.wrenyardShell.requestTaskRoutingTest({ automatic: {} })]).then(([tasks, test]) => Array.isArray(tasks?.tasks) && tasks.tasks.length > 0 && tasks.tasks.every((task) => typeof task.identity === 'string' && typeof task.name === 'string' && typeof task.display_name === 'string' && task.automatic && typeof task.automatic === 'object') && Array.isArray(test?.rows)).catch(() => false)",
    );
    // Stats bridge capability: the snapshot must report a known status.
    const statsOk = await shell.window.webContents.executeJavaScript(
      "window.wrenyardShell.getStats().then((value) => value?.status === 'available' || value?.status === 'unavailable').catch(() => false)",
    );
    // Page ownership lives on the mounted `[data-page]` React roots, not on
    // `<html>`: drive each page and require its root to become visible.
    shell.setPage('settings', false);
    const settingsVisible = await waitForVisiblePageRoot(shell, 'settings');
    shell.setPage('stats', false);
    const statsVisible = await waitForVisiblePageRoot(shell, 'stats');
    shell.setPage('quota', false);
    const quotaVisible = await waitForVisiblePageRoot(shell, 'quota');
    shell.setPage('tasks', false);
    const tasksVisible = await waitForVisiblePageRoot(shell, 'tasks');
    shell.setPage('session', false);
    const sessionVisible = await waitForVisiblePageRoot(shell, 'session');
    if (!shellOk || !snapshotOk || !quotaOk || !tasksOk || !routingOk || !statsOk || !settingsVisible || !statsVisible || !quotaVisible || !tasksVisible || !sessionVisible) {
      throw new Error(
        `smoke failed (shell=${shellOk}, snapshot=${snapshotOk}, quota=${quotaOk}, tasks=${tasksOk}, routing=${routingOk}, stats=${statsOk}, settings=${settingsVisible}, statsPage=${statsVisible}, quotaPage=${quotaVisible}, tasksPage=${tasksVisible}, session=${sessionVisible})`,
      );
    }
  };
  await Promise.race([
    check(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`)), SMOKE_TIMEOUT_MS);
    }),
  ]);
}

/** Refresh quota/provider projection once and notify existing surfaces after a daemon restart. */
async function refreshQuotaProjectionAfterGatewayRestart(): Promise<void> {
  try {
    await quotaController?.getSnapshot(true);
    shellWindow?.notifyQuotaChanged();
  } catch (error) {
    console.warn('[wrenyard-desktop] quota refresh after gateway restart failed:', error instanceof Error ? error.message : String(error));
  }
}

/** Session IPC relay; null until bootstrap registers it. */
let sessionRegistration: SessionRegistration | null = null;
let shellWindow: ShellWindowController | null = null;
/** The single Desktop notification owner; created during bootstrap. */
let notificationCenter: NotificationCenter | null = null;
/** Live settings store, mirrored for notification preference reads. */
let desktopSettingsStore: DesktopSettingsStore | null = null;
let desktopTray: DesktopTrayHandle | null = null;
let petController: DesktopPetController | null = null;
let desktopSubscriptions: DaemonSubscriptions | null = null;
let taskgraphWindowOwner: TaskGraphWindowOwner | null = null;
let quotaController: DesktopQuotaController | null = null;
let appearanceController: DesktopAppearanceController | null = null;
let updateController: DesktopUpdateController | null = null;
let daemonSupervisor: DesktopDaemonSupervisor | null = null;
/** Latest known product workspace; refreshed when a save activates a new root. */
let workspaceConfiguration: WorkspaceConfigurationSnapshot | null = null;
let daemonRunning = false;
const canConnectDaemon = (): boolean => daemonSupervisor?.snapshot().state === 'running';
function requireDaemonRunning(): void {
  if (!canConnectDaemon()) throw new Error('daemon 不可用');
}
function reconcileDaemonConnection(running: boolean): void {
  if (daemonRunning === running) return;
  daemonRunning = running;
  if (!running) {
    desktopSubscriptions?.pause();
    sessionRegistration?.disconnect();
    return;
  }
  desktopSubscriptions?.reconnect();
  taskgraphWindowOwner?.reconnect();
  void refreshQuotaProjectionAfterGatewayRestart();
}
let quitController: QuitController | null = null;
/** Set only inside finalizeQuit, immediately before the final app.quit(). */
let finalExit = false;
let openSettingsOnReady = process.argv.some(isSettingsLaunchRequest);
let updateDialogActive = false;

/**
 * macOS Cmd+Q confirmation gate: one 3000ms window shared by every
 * accelerator-driven quit request. Direct/programmatic quits bypass it.
 */
const macQuitGate = createMacQuitConfirmationGate({ windowMs: 3_000 });

function daemonSnapshot(): DaemonLifecycleSnapshot {
  return daemonSupervisor?.snapshot()
    ?? { mode: 'connected', state: 'unavailable', canStart: false, restartCount: 0 };
}

function notifyDaemonChanged(): void {
  if (shellWindow && !shellWindow.window.isDestroyed()) {
    shellWindow.window.webContents.send(SHELL_CHANNELS.daemonChanged);
  }
}

/**
 * OS notification for a background-worthy event. Clicking it focuses the main
 * window and delivers the event's command action to the renderer, which owns
 * the command table.
 */
function showSystemNotification(notification: ShellNotification): void {
  if (!ElectronNotification.isSupported()) return;
  const native = new ElectronNotification({
    title: notification.title,
    body: notification.description ?? '',
    silent: !(desktopSettingsStore?.load().notifications.sound ?? true),
  });
  native.on('click', () => {
    showDesktop();
    const command = notification.action?.command;
    if (command) shellWindow?.deliverCommandAction(command);
  });
  native.show();
}

/** An available update feeds the notification center once per version. */
function notifyUpdateAvailable(): void {
  if (notificationCenter === null || desktopSettingsStore === null) return;
  const snapshot = updateController?.snapshot();
  if (!snapshot || snapshot.state !== 'available') return;
  if (!desktopSettingsStore.load().notifications.events.updateAvailable) return;
  notificationCenter.push({
    id: 'update-available',
    level: 'info',
    source: 'update',
    title: '有可用更新',
    ...(snapshot.availableVersion !== undefined ? { description: `新版本 ${snapshot.availableVersion} 已可用` } : {}),
    action: { label: '查看', command: { id: 'settings.open', args: 'update' } },
  });
}

/** A daemon drop feeds the center; recovery clears the stale disconnect. */
let lastDaemonState: DaemonLifecycleSnapshot['state'] | undefined;
function notifyDaemonStateChanged(snapshot: DaemonLifecycleSnapshot): void {
  const previous = lastDaemonState;
  lastDaemonState = snapshot.state;
  if (notificationCenter === null || desktopSettingsStore === null) return;
  if (snapshot.state === 'running') {
    notificationCenter.dismiss('daemon-disconnected');
    return;
  }
  if (previous !== 'running') return;
  if (!desktopSettingsStore.load().notifications.events.daemonDisconnected) return;
  notificationCenter.push({
    id: 'daemon-disconnected',
    level: 'warning',
    source: 'daemon',
    title: 'Daemon 已断开',
    ...(snapshot.message !== undefined ? { description: snapshot.message } : {}),
  });
}

/** Preference gate for task events the Pet module reports. */
function petNotificationSink(input: NotificationInput): void {
  if (notificationCenter === null || desktopSettingsStore === null) return;
  const events = desktopSettingsStore.load().notifications.events;
  const enabled = input.level === 'success'
    ? events.taskCompleted
    : input.level === 'error'
      ? events.taskFailed
      : true;
  if (!enabled) return;
  notificationCenter.push(input);
}

/** Final teardown shared by every exit path; the daemon stop already happened. */
async function finalizeQuit(): Promise<void> {
  try {
    desktopTray?.destroy();
    desktopTray = null;
    quotaController?.stop();
    quotaController = null;
    appearanceController?.dispose();
    appearanceController = null;
    updateController?.stop();
    updateController = null;
    daemonSupervisor?.dispose();
    daemonSupervisor = null;
    await petController?.stop();
    petController = null;
    // Tear down the shared daemon subscriptions and the Desktop-owned task
    // windows after the Pet module stops consuming them.
    desktopSubscriptions?.dispose();
    desktopSubscriptions = null;
    taskgraphWindowOwner?.destroy();
    taskgraphWindowOwner = null;
    // Stop the relay; session turns remain owned by the daemon.
    await sessionRegistration?.close();
    sessionRegistration = null;
  } catch {
    // best-effort termination
  } finally {
    finalExit = true;
    app.quit();
    // A SIGTERM-initiated quit (e.g. pnpm dev) stalls after this second
    // app.quit(); teardown is already done, so exit if still alive.
    setTimeout(() => app.exit(0), 1_000);
  }
}

function showDesktop(page: ShellPage = 'session'): void {
  // Every surface is inert for the whole pending quit, not only the modal.
  if (quitController?.isQuitting()) return;
  if (!shellWindow || shellWindow.window.isDestroyed()) {
    if (page === 'settings') openSettingsOnReady = true;
    return;
  }
  if (shellWindow.window.isMinimized()) shellWindow.window.restore();
  shellWindow.window.show();
  shellWindow.window.focus();
  shellWindow.setPage(page);
}

function showUpdateMessage(options: MessageBoxOptions) {
  const parent = shellWindow?.window;
  return parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

let quitSurfacesBlocked = false;
let preQuitMenu: Menu | null = null;

/**
 * Make every window and menu surface inert for the *entire* pending quit, not
 * only while the drain dialog is open: the application menu is removed, the
 * shell is disabled, and the Pet/graph entity windows are hidden. The
 * stored menu and geometry are restored only if the quit never happens.
 */
function blockQuitSurfaces(): void {
  if (quitSurfacesBlocked) return;
  quitSurfacesBlocked = true;
  preQuitMenu = Menu.getApplicationMenu();
  Menu.setApplicationMenu(null);
  // Every existing window (shell, Pet house, Wren/graph entities) is disabled;
  // the drain dialog is created afterwards and stays interactive.
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setEnabled(false);
  }
  taskgraphWindowOwner?.setEntitiesVisible(false);
}

/** Undo {@link blockQuitSurfaces} for a quit that did not proceed. */
function restoreQuitSurfaces(): void {
  if (!quitSurfacesBlocked) return;
  quitSurfacesBlocked = false;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setEnabled(true);
  }
  if (preQuitMenu) Menu.setApplicationMenu(preQuitMenu);
  preQuitMenu = null;
  const pet = petController?.getConfig();
  taskgraphWindowOwner?.setEntitiesVisible(
    (pet?.enabled ?? true) && (pet?.entities.taskgraphs ?? true),
  );
}

/**
 * Blocking drain dialog shown while a supervised daemon still has running
 * tasks or graphs. It has exactly one action ("强制结束"), reports live counts,
 * and cannot be closed by the user: only drain completion or the button.
 */
const QUIT_DIALOG_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>退出啾啾工坊</title><style>
body{margin:0;padding:24px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#1f1f24;color:#f2f2f5}
h1{margin:0 0 8px;font-size:16px}
p{margin:0 0 8px;font-size:13px;color:#c8c8d0}
.counts{font-size:13px;color:#f2f2f5}
button{margin-top:16px;padding:8px 18px;border:0;border-radius:6px;background:#c0392b;color:#fff;font-size:13px;cursor:pointer}
</style></head><body>
<h1>正在退出啾啾工坊</h1>
<p>后台仍有任务运行，全部完成后将自动停止服务并退出。</p>
<p class="counts">运行中的任务：<span id="tasks">0</span> · 任务图：<span id="graphs">0</span></p>
<p class="counts" id="status"></p>
<button id="force">强制结束</button>
</body></html>`;

function createQuitDialogPresenter() {
  return {
    open(counts: QuitCounts | null): QuitDialogHandle {
      const parent = shellWindow?.window;
      // A modal child needs a visible parent to render on every platform.
      if (parent && !parent.isDestroyed()) parent.show();
      // The app menu is another quit entry point; remove it while blocking.
      const previousMenu = Menu.getApplicationMenu();
      Menu.setApplicationMenu(null);
      const window = new BrowserWindow({
        width: 420,
        height: 220,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: false,
        frame: false,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        ...(parent && !parent.isDestroyed() ? { parent, modal: true } : {}),
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      let resolveForced: () => void = () => undefined;
      window.setEnabled(true);
      const forced = new Promise<void>((resolve) => { resolveForced = resolve; });
      // Taskgraph counts come from the daemon's taskgraph field; the legacy
      // workflow count is never displayed as 任务图. A null status is shown as
      // "confirming" instead of a false zero.
      const setCounts = (value: QuitCounts | null): string => value === null
        ? "document.getElementById('tasks').textContent = '—';"
          + "document.getElementById('graphs').textContent = '—';"
          + "document.getElementById('status').textContent = '正在确认后台状态…';"
        : `document.getElementById('tasks').textContent = ${JSON.stringify(String(value.activeTaskCount))};`
          + `document.getElementById('graphs').textContent = ${JSON.stringify(String(value.activeTaskGraphCount))};`
          + "document.getElementById('status').textContent = '';";
      window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
      window.webContents.once('did-finish-load', () => {
        void window.webContents.executeJavaScript(
          `(() => { ${setCounts(counts)} return new Promise((resolve) => { document.getElementById('force').addEventListener('click', () => resolve(true)); }); })()`,
        ).then(() => resolveForced()).catch(() => undefined);
      });
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(QUIT_DIALOG_HTML)}`);
      return {
        update: (value) => {
          if (!window.isDestroyed()) void window.webContents.executeJavaScript(setCounts(value)).catch(() => undefined);
        },
        focus: () => { if (!window.isDestroyed()) { window.show(); window.focus(); } },
        close: () => {
          Menu.setApplicationMenu(previousMenu);
          if (!window.isDestroyed()) window.destroy();
        },
        forced,
      };
    },
  };
}

async function requestInstallFromMenu(): Promise<void> {
  if (!updateController || updateDialogActive || quitController?.isQuitting()) return;
  updateDialogActive = true;
  try {
    const snapshot = await updateController.checkForUpdates();
    if (snapshot.state !== 'available' && snapshot.state !== 'waiting') {
      await showUpdateMessage({
        type: snapshot.state === 'error' ? 'error' : 'info',
        title: '软件更新',
        message: snapshot.state === 'up-to-date' ? '啾啾工坊已是最新版本' : '暂时无法检查更新',
        detail: snapshot.message ?? `当前版本为 v${snapshot.currentVersion}。`,
        buttons: ['好'],
        noLink: true,
      });
      return;
    }
    // One click authorizes the flow; the controller applies the update and then
    // quits through the already-idle path (no drain dialog).
    await updateController.requestInstall();
  } finally {
    updateDialogActive = false;
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  console.info('[wrenyard-desktop] initializing catalog');
  const { refreshDesktopCatalog } = await import('./builtin-catalog.js');
  await refreshDesktopCatalog();
  console.info('[wrenyard-desktop] catalog ready');
  await ensureDesktopActivationPolicy({
    setActivationPolicy: (policy) => app.setActivationPolicy(policy),
    ...(app.dock ? { showDock: () => app.dock!.show() } : {}),
  });
  const ipcPath = resolveWrenyardIpcPath();
  const pageLoader = createPageLoader({ appPath: app.getAppPath(), packaged: app.isPackaged, env: process.env });
  workspaceConfiguration = await inspectProductWorkspace();
  console.info('[wrenyard-desktop] workspace ready');

  const requestForeman = async (method: string, params: unknown): Promise<unknown> => {
    requireDaemonRunning();
    const client = new WrenyardIpcClient({ path: ipcPath, requestTimeoutMs: TASK_SETTINGS_REQUEST_TIMEOUT_MS });
    try {
      return await client.request(method, params);
    } finally {
      await client.close?.();
    }
  };
  const readUpdateDaemonIdle = async (): Promise<boolean | null> => {
    try {
      return assertDaemonIdle(await requestForeman('daemon.status', {})).idle;
    } catch {
      // A confirmed-absent daemon (unreachable probe) is idle; a reachable but
      // unreadable one stays unknown so the install defers instead of guessing.
      if (daemonSupervisor?.snapshot().pid !== undefined) return null;
      return (await probeWrenyard(ipcPath)).connected ? null : true;
    }
  };
  const mapRuntimeAliasError = (error: unknown): never => {
    if (error instanceof WrenyardRpcError) {
      const code = (error.data as { code?: string } | undefined)?.code;
      if (code !== undefined && code in RUNTIME_ALIAS_ERROR_MESSAGES) {
        const mapped = new Error(RUNTIME_ALIAS_ERROR_MESSAGES[code]);
        (mapped as { code?: string }).code = code;
        throw mapped;
      }
    }
    throw error;
  };
  const getRuntimeAliasSnapshot = async (): Promise<RuntimeAliasSnapshot> => {
    return (await requestForeman('runtime.alias.snapshot', {})) as RuntimeAliasSnapshot;
  };
  const putRuntimeAlias = async (request: RuntimeAliasPutRequest): Promise<RuntimeAliasSnapshot> => {
    try {
      return (await requestForeman('runtime.alias.put', {
        expected_revision: request.expected_revision,
        name: request.name,
        target: request.target,
      })) as RuntimeAliasSnapshot;
    } catch (error) {
      throw mapRuntimeAliasError(error);
    }
  };
  const removeRuntimeAlias = async (request: RuntimeAliasRemoveRequest): Promise<RuntimeAliasSnapshot> => {
    try {
      return (await requestForeman('runtime.alias.remove', {
        expected_revision: request.expected_revision,
        name: request.name,
      })) as RuntimeAliasSnapshot;
    } catch (error) {
      throw mapRuntimeAliasError(error);
    }
  };
  const getTaskSettings = async (project?: string, taskId?: string): Promise<TaskSettingsSnapshot> => {
    const params: Record<string, unknown> = {};
    if (project !== undefined) params.project = project;
    if (taskId !== undefined) params.task_id = taskId;
    return (await requestForeman('task.settings.snapshot', params)) as TaskSettingsSnapshot;
  };
  // Read-only routing test: the daemon owns evaluation, ranking, and scoring.
  // Desktop only forwards the typed form request and transports the result back.
  const requestTaskRoutingTest = async (params: TaskRoutingTestParams): Promise<TaskRoutingTestResult> => {
    const request: Record<string, unknown> = { automatic: params.automatic };
    if (params.timeout_ms !== undefined) request.timeout_ms = params.timeout_ms;
    return (await requestForeman('task.settings.routingTest', request)) as TaskRoutingTestResult;
  };
  // Read-only import list: raw definition automatic configuration for every
  // valid builtin and project task. No effective user settings, no inference.
  const requestRoutingTestTasks = async (): Promise<TaskRoutingTestTasksResult> => {
    return (await requestForeman('task.settings.routingTestTasks', {})) as TaskRoutingTestTasksResult;
  };
  const saveTaskSettings = async (request: TaskSettingsSaveRequest): Promise<TaskSettingsSnapshot> => {    const params: Record<string, unknown> = {
      scope: request.scope,
      expected_revision: request.expected_revision,
      patch: request.patch,
    };
    if (request.task_id !== undefined) params.task_id = request.task_id;
    if (request.project !== undefined) params.project = request.project;
    try {
      return (await requestForeman('task.settings.save', params)) as TaskSettingsSnapshot;
    } catch (error) {
      if (error instanceof WrenyardRpcError) {
        const code = (error.data as { code?: string } | undefined)?.code;
        if (code !== undefined && code in TASK_SETTINGS_SAVE_ERROR_MESSAGES) {
          const conflict = new Error(TASK_SETTINGS_SAVE_ERROR_MESSAGES[code]);
          (conflict as { code?: string }).code = code;
          throw conflict;
        }
      }
      throw error;
    }
  };
  // Raw prompt-execution transport. Desktop forwards an already-resolved
  // request to the daemon exec.* methods and returns their bounded snapshots
  // and events unchanged; it never resolves a model, reads a catalog, or
  // persists an execution.
  const execStart = async (request: ExecStartRequest): Promise<ExecSnapshotDto> => {
    const result = (await requestForeman('exec.start', request)) as { execution: ExecSnapshotDto };
    return result.execution;
  };
  const execGet = async (id: string): Promise<ExecSnapshotDto> => {
    const result = (await requestForeman('exec.get', { id })) as { execution: ExecSnapshotDto };
    return result.execution;
  };
  const execEvents = async (request: ExecEventsRequest): Promise<ExecEventsResult> => {
    const params: Record<string, unknown> = { id: request.id };
    if (request.afterSeq !== undefined) params.afterSeq = request.afterSeq;
    return (await requestForeman('exec.events', params)) as ExecEventsResult;
  };
  const execCancel = async (id: string): Promise<{ id: string; status: ExecSnapshotDto['status'] }> => {
    return (await requestForeman('exec.cancel', { id })) as { id: string; status: ExecSnapshotDto['status'] };
  };

  // The updater is constructed and preflighted *before* the daemon is started
  // or contacted: a startup blocker (DMG-in-place, translocation) must end
  // startup before any control connection opens. Its daemon closures resolve
  // the supervisor later, once it exists.
  updateController = new DesktopUpdateController({
    currentVersion: app.getVersion(),
    userDataPath: app.getPath('userData'),
    appPath: resolveUpdateAppPath(),
    readDaemonIdle: readUpdateDaemonIdle,
    // Confirms whether the daemon process is actually running, so a stopped
    // connected-mode daemon can still be updated.
    isDaemonRunning: async () => daemonSupervisor?.snapshot().pid !== undefined || (await probeWrenyard(ipcPath)).connected,
    // Who stops the daemon for the apply step, and how.
    daemonMode: () => daemonSupervisor?.mode ?? 'connected',
    stopDaemon: () => daemonSupervisor?.stop() ?? Promise.resolve(),
    // A platform blocker (DMG run, translocation, unwritable install) is shown
    // as a modal; a startup blocker ends startup, an update blocker aborts it.
    onBlocker: async (blocker) => {
      await showUpdateMessage({
        type: 'warning',
        title: '无法更新',
        message: blocker.message,
        buttons: ['好'],
        noLink: true,
      });
    },
    // Applying the update quits through the already-idle path: never drain.
    onInstall: () => {
      // Block every surface before the teardown so no action slips through.
      blockQuitSurfaces();
      quitController?.requestQuit({ bypassDrain: true });
    },
    onChanged: () => {
      shellWindow?.notifyUpdateChanged();
      notifyUpdateAvailable();
    },
    sourceDevelopment: !app.isPackaged,
  });
  // macOS DMG-in-place and AppTranslocation runs are blocked before any window
  // opens: the modal is confirmed, then Desktop exits.
  if (!(await updateController.preflightStartup())) {
    app.exit(0);
    return;
  }

  let startupFinalized = false;
  // Finalize a pending update only once the shell has actually loaded and the
  // daemon is healthy. A startup where the daemon was unavailable finalizes on
  // the later healthy recovery instead of being skipped forever.
  const finalizeWhenHealthy = async (): Promise<void> => {
    if (startupFinalized) return;
    if (shellWindow === null || daemonSnapshot().state !== 'running') return;
    startupFinalized = true;
    try {
      await updateController?.finalizeStartup();
    } catch (error) {
      console.warn('[wrenyard-desktop] update finalize failed:', error instanceof Error ? error.message : String(error));
    }
  };

  // Ownership is fixed at boot. An incompatible daemon still owns its endpoint.
  // Only an installed Desktop ships a daemon it can launch; a source Desktop connects and waits.
  const initialProbe = await probeWrenyard(ipcPath);
  daemonSupervisor = new DesktopDaemonSupervisor({
    launch: app.isPackaged ? packagedDaemonLaunch(join(process.resourcesPath, 'wrenyard'), resolveForemanConfigPath()) : null,
    logsDir: join(foremanStateRoot(), 'logs'),
    ipcPath,
    initialProbe,
    desktopVersion: app.getVersion(),
    probe: () => probeWrenyard(ipcPath),
    forceShutdown: async () => {
      const client = new WrenyardIpcClient({ path: ipcPath });
      try { await client.request('daemon.shutdown', { reason: 'desktop force quit', force: true }); }
      finally { client.close(); }
    },
    onChanged: (snapshot) => {
      reconcileDaemonConnection(snapshot.state === 'running');
      notifyDaemonChanged();
      notifyDaemonStateChanged(snapshot);
      void finalizeWhenHealthy();
    },
  });
  const daemonStart = daemonSupervisor.start().catch((error: unknown) => {
    console.warn('[wrenyard-desktop] daemon start failed:', error instanceof Error ? error.message : String(error));
  });
  // Smoke asserts a ready backend, so it must wait for the daemon to come up.
  if (SMOKE) await daemonStart;
  const readDaemonCounts = async (): Promise<QuitCounts | null> => {
    const toCount = (value: unknown): number =>
      (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
    try {
      const status = await requestForeman('daemon.status', {}) as Record<string, unknown>;
      // `idle` already accounts for tasks, taskgraphs, executions and
      // sessions, so it is the only readiness signal; counts are display
      // only and taskgraphs come from `activeTaskGraphCount`.
      if (status.ok !== true || typeof status.idle !== 'boolean') return null;
      return {
        idle: status.idle,
        activeTaskCount: toCount(status.activeTaskCount),
        activeTaskGraphCount: toCount(status.activeTaskGraphCount),
      };
    } catch {
      // Status unavailable: only a daemon Desktop does not own (no live child)
      // is confirmed absent and thus idle; an owned child keeps us waiting.
      const ownsLiveChild = daemonSupervisor?.mode === 'supervised'
        && daemonSupervisor.snapshot().pid !== undefined;
      return ownsLiveChild ? null : { idle: true, activeTaskCount: 0, activeTaskGraphCount: 0 };
    }
  };
  quitController = createQuitController({
    daemonMode: () => daemonSupervisor?.mode ?? 'connected',
    readCounts: readDaemonCounts,
    stopDaemon: () => daemonSupervisor?.stop() ?? Promise.resolve(),
    forceCancel: () => daemonSupervisor?.forceStop() ?? Promise.resolve(),
    presenter: createQuitDialogPresenter(),
    exit: () => { void finalizeQuit(); },
  });

  // macOS/Linux OS shutdown: cancel all work and force-quit with no dialog.
  // Registered only after the app is ready, as powerMonitor requires.
  powerMonitor.on('shutdown', (event?: Electron.Event) => {
    if (typeof event?.preventDefault === 'function') event.preventDefault();
    blockQuitSurfaces();
    quitController?.forceQuit();
  });

  console.info('[wrenyard-desktop] initializing shell');

  // Relay session IPC over the same owner-only daemon control socket.
  sessionRegistration = registerSession({
    ipcPath,
    canConnect: canConnectDaemon,
    // The shell window is created after this registration, so read the live
    // pointer on each call instead of capturing it.
    isShellSender: (sender) =>
      Boolean(shellWindow && !shellWindow.window.isDestroyed() && sender.id === shellWindow.window.webContents.id),
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const petAssets = resolvePetAssets();
  const settingsPath = join(app.getPath('userData'), 'settings.json');
  console.info(`[wrenyard-desktop] settings path: ${settingsPath}`);
  const settingsStore = new DesktopSettingsStore({
    path: settingsPath,
    onChange: () => desktopTray?.rebuild(),
  });
  // Surface an unreadable/incompatible document explicitly instead of letting a
  // corrupt file be silently replaced with defaults. The original file is kept.
  let loadedSettings: ReturnType<DesktopSettingsStore['load']> | undefined;
  try {
    loadedSettings = settingsStore.load();
  } catch (error) {
    console.warn('[wrenyard-desktop] Desktop settings could not be loaded:', error instanceof Error ? error.message : String(error));
  }
  // Appearance is main-owned and resolved before any window opens: it sets
  // `nativeTheme.themeSource`, the window background/palette/icons, and pushes
  // only a changed resolution to the renderer.
  appearanceController = new DesktopAppearanceController({
    store: settingsStore,
    onChanged: (appearance) => shellWindow?.notifyAppearanceChanged(appearance),
  });
  appearanceController.init();
  desktopSettingsStore = settingsStore;
  // One notification owner for the whole process. Main-origin (update, daemon,
  // Pet task) and renderer-originated events all land here; the center decides
  // history, foreground toasts and OS notifications, so nothing fires twice.
  notificationCenter = new NotificationCenter({
    onChanged: () => shellWindow?.notifyNotificationsChanged(),
    isForeground: () => Boolean(
      shellWindow && !shellWindow.window.isDestroyed() && shellWindow.window.isFocused(),
    ),
    isSystemEnabled: () => settingsStore.load().notifications.system,
    onSystemNotification: (notification) => showSystemNotification(notification),
    doNotDisturb: loadedSettings?.notifications.doNotDisturb ?? false,
  });
  // One shared daemon transport and subscription set for the whole Desktop
  // process. The shell window, tray and Pet all consume the same rounds; the
  // Pet never opens its own connection or timer.
  const daemonClient = new WrenyardDaemonClient({ path: ipcPath, canConnect: canConnectDaemon });
  const windowOwner = new TaskGraphWindowOwner({
    daemonClient,
    pageLoader,
    preloadDir: petAssets.preloadDir,
    // TaskGraph detail/transcript windows are general Desktop windows: they are
    // reachable from the shell whether or not the Pet module is running.
    getHouseWindow: () => petController?.getHouseWindow() ?? null,
    graphSlipGeometry: loadedSettings?.window.graphSlip,
    onGraphSlipGeometryChange: (geometry) => {
      settingsStore.patch('window', { ...settingsStore.load().window, graphSlip: geometry });
    },
    entitiesVisible: (loadedSettings?.pet.visible ?? true)
      && (loadedSettings?.pet.entities.taskgraphs ?? true),
    logger: console,
  });
  taskgraphWindowOwner = windowOwner;
  desktopSubscriptions = new DaemonSubscriptions({
    client: daemonClient,
    ipcPath,
    getTrackedTaskgraphIds: () => windowOwner.getTrackedTaskgraphIds(),
  });
  if (canConnectDaemon()) desktopSubscriptions.start();
  // The single shared activity round feeds the general TaskGraph windows as
  // well, so Wren entities and Graph Slips stay live even while Pet is hidden.
  desktopSubscriptions.subscribe({
    onActivity: (presence) => windowOwner.applyActivity(presence),
  });

  petController = new DesktopPetController({
    store: settingsStore,
    createRuntime: (config, onConfigChange) => new DesktopPetRuntime({
      config,
      pageLoader,
      preloadDir: petAssets.preloadDir,
      subscriptions: desktopSubscriptions!,
      onConfigChange,
      onNotification: petNotificationSink,
      debugRenderer: process.env.PET_DEBUG === '1' || process.env.PET_DEBUG === 'true',
    }),
    listDisplays: () => screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      label: `显示器 ${index + 1}`,
      isPrimary: display.id === screen.getPrimaryDisplay().id,
    })),
  });
  const petStart = petController.start().catch((error: unknown) => {
    console.warn('[wrenyard-desktop] Pet module failed to start:', error);
  });
  if (SMOKE) await petStart;
  const providerService = new ProviderService({ ipcPath, canConnect: canConnectDaemon });
  quotaController = new DesktopQuotaController({
    source: new DesktopQuotaSource(ipcPath, canConnectDaemon),
    providerSource: providerService,
    getProviderOrder: () => settingsStore.load().providers.providers,
    onChanged: (_snapshot, providers) => {
      petController?.setQuotaProviders(providers);
      desktopTray?.rebuild();
      shellWindow?.notifyQuotaChanged();
    },
  });
  // Provider discovery may wait on native clients; it must not delay the window.
  void quotaController.start().catch((error: unknown) => {
    console.warn('[wrenyard-desktop] initial quota refresh failed:', error);
  });

  /**
   * Reactivate the daemon after a workspace change: gate on an idle daemon,
   * run a planned CLI restart, and let the restarted daemon bind the saved
   * workspace from config. Any failure stays visible instead of claiming
   * activation succeeded, and a busy daemon is never interrupted.
   */
  const version = app.getVersion();
  const buildTime = resolveDesktopBuildTime();
  const getSettings = async () => buildSettingsSnapshot({
    endpoint: ipcPath,
    workspace: workspaceConfiguration!,
    desktopVersion: version,
    wrenyardVersion: version,
    buildTime,
    readHealth: () => canConnectDaemon() ? readWrenyardHealth(ipcPath) : Promise.resolve({ connected: false }),
    readGatewayModels: () => { requireDaemonRunning(); return readGatewayConnection(ipcPath).then((connection) => connection.models); },
    readPet: async () => petController!.snapshot(),
    readUpdate: () => updateController!.snapshot(),
    sourceDevelopment: !app.isPackaged,
  });
  // Daemon lifecycle surface: read the live projection, or start/restart the
  // daemon when this Desktop supervises it.
  ipcMain.handle(SHELL_CHANNELS.daemonSnapshot, () => daemonSnapshot());
  ipcMain.handle(SHELL_CHANNELS.daemonStart, async () => {
    if (quitController?.isQuitting()) return daemonSnapshot();
    await daemonSupervisor?.start();
    return daemonSnapshot();
  });
  ipcMain.handle(SHELL_CHANNELS.daemonRestart, async () => {
    if (quitController?.isQuitting()) return daemonSnapshot();
    if (daemonSupervisor?.mode === 'supervised') await daemonSupervisor.restart();
    else await daemonSupervisor?.start();
    return daemonSnapshot();
  });

  shellWindow = await ShellWindowController.create({
    pageLoader,
    preloadPath: preloadPath(app.getAppPath(), 'shell'),
    appVersion: version,
    smoke: SMOKE,
    icon: appearanceController.iconPath('png256') ?? resolveAppIcon(),
    initialAppearance: appearanceController.resolve(),
    backgroundColor: appearanceController.backgroundColor(),
    titleBarOverlay: appearanceController.titleBarOverlay(),
    additionalArguments: appearanceController.arguments(),
    onCreated: (controller) => { shellWindow = controller; },
    getAppearance: () => appearanceController!.resolve(),
    getAppearanceSettings: async () => appearanceController!.getSettings(),
    setAppearance: async (settings) => appearanceController!.save(settings),
    getSettings,
    getStats: () => { requireDaemonRunning(); return readStatsSnapshot(ipcPath); },
    getQuota: (forceRefresh = false) => quotaController!.getSnapshot(forceRefresh),
    saveProviderOrder: async (providerIds: string[]) => {
      settingsStore.patch('providers', {
        providers: reorderProviders(settingsStore.load().providers.providers, providerIds),
      });
      return quotaController!.notifyConfigurationChanged();
    },
    configureProviderKey: async (providerId: string, key: string) => {
      // The daemon owns the gateway routes and the session backend picks up
      // changed credentials itself; Desktop only refreshes the quota surface.
      await providerService.configureApiKey(providerId, key);
      return quotaController!.getSnapshot(true);
    },
    getUpdate: async () => updateController!.snapshot(),
    checkUpdate: () => updateController!.checkForUpdates(),
    requestInstall: () => updateController!.requestInstall(),
    savePetSettings: async (settings: PetCompanionSettings) => {
      // Provider order has one mutation surface: the Provider page. A stale
      // settings draft must never overwrite that order when Pet settings save.
      const providerOrder = petController!.getConfig().quota.providers;
      await petController!.saveSettings({
        ...settings,
        quota: { providers: providerOrder },
      });
      quotaController?.notifyConfigurationChanged();
      return getSettings();
    },
    saveWorkspace: async (path: string, create = false) => {
      // From source, the daemon's own dev script relaunches it after a clean shutdown.
      const sourceDaemon = !app.isPackaged;
      if (!sourceDaemon && daemonSupervisor?.mode !== 'supervised') {
        throw new Error('daemon 由终端管理，请先停止它，再由啾啾工坊启动后切换工作区。');
      }
      const idle = assertDaemonIdle(await requestForeman('daemon.status', {}));
      if (!idle.idle) throw new Error(idle.reason);
      const saved = create ? await createProductWorkspace(path) : await saveProductWorkspace(path);
      if (sourceDaemon) {
        await requestForeman('daemon.shutdown', { reason: 'source-development workspace activation' });
        await waitForSourceDaemonRestart(ipcPath);
        await daemonSupervisor!.start();
      } else {
        await restartOwnedDaemon(daemonSupervisor!);
      }
      // The daemon reads the workspace from config at startup, so the restarted
      // daemon is already bound to it; Desktop only republishes the new root.
      workspaceConfiguration = saved;
      notifyDaemonChanged();
      return saved;
    },
    // Task detail/transcript windows are general Desktop windows, owned by the
    // window owner and reachable even when Pet is hidden.
    openTaskTranscript: (taskRunId) => windowOwner.openTaskTranscript(taskRunId),
    getTaskSettings: (project?: string, taskId?: string) => getTaskSettings(project, taskId),
    saveTaskSettings: (request: TaskSettingsSaveRequest) => saveTaskSettings(request),
    runtimeAliasSnapshot: () => getRuntimeAliasSnapshot(),
    runtimeAliasPut: (request: RuntimeAliasPutRequest) => putRuntimeAlias(request),
    runtimeAliasRemove: (request: RuntimeAliasRemoveRequest) => removeRuntimeAlias(request),
    requestTaskRoutingTest: (params: TaskRoutingTestParams) => requestTaskRoutingTest(params),
    requestRoutingTestTasks: () => requestRoutingTestTasks(),
    // Summary model projection and persistence are owned by the session feature;
    // Desktop is only a typed transport for its canonical IPC methods, which
    // return the settings snapshot directly.
    getSummarySettings: async (): Promise<SummarySettingsSnapshot> =>
      (await requestForeman('session.summary.settings', {})) as SummarySettingsSnapshot,
    saveSummaryModel: async (canonicalModel: string): Promise<SummarySettingsSnapshot> =>
      (await requestForeman('session.summary.save', { canonicalModel })) as SummarySettingsSnapshot,
    execStart: (request: ExecStartRequest) => execStart(request),
    execGet: (id: string) => execGet(id),
    execEvents: (request: ExecEventsRequest) => execEvents(request),
    execCancel: (id: string) => execCancel(id),
    getNotifications: async () => notificationCenter!.snapshot(),
    notify: async (input: NotificationInput) => notificationCenter!.push(input),
    dismissNotification: async (id: string) => { notificationCenter?.dismiss(id); },
    clearNotifications: async () => { notificationCenter?.clear(); },
    markNotificationsRead: async () => { notificationCenter?.markAllRead(); },
    setDoNotDisturb: async (value: boolean) => {
      settingsStore.patch('notifications', { ...settingsStore.load().notifications, doNotDisturb: value });
      notificationCenter?.setDoNotDisturb(value);
      return notificationCenter!.snapshot();
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(desktopMenuTemplate(
    process.platform,
    () => { void requestInstallFromMenu(); },
    (origin: QuitOrigin) => {
      // A pending quit already owns the flow; never start another one.
      if (quitController?.isQuitting()) return;
      if (origin === 'direct') {
        app.quit();
        return;
      }
      if (macQuitGate('accelerator') === 'quit') {
        app.quit();
        return;
      }
      // Warn, never quit: a second Cmd+Q inside the 3s window fully exits
      // while Cmd+W only backgrounds. The dialog is intentionally non-blocking.
      // A first press never starts a quit, so make sure nothing stays blocked.
      restoreQuitSurfaces();
      void showUpdateMessage({
        type: 'warning',
        title: '退出啾啾工坊',
        message: '再次按下 Cmd+Q 将完全退出',
        detail: '3 秒内再次按下 Cmd+Q 才会完全退出并停止后台服务；Cmd+W 只会将窗口隐藏到托盘。',
        buttons: ['好'],
        noLink: true,
      });
    },
  )));
  if (!SMOKE && app.isPackaged) updateController.start();

  // A new version health-starts and the shell is loaded: settle the pending
  // update result and run the platform finalize (applier cleanup). If the
  // daemon was unavailable at startup, the healthy recovery above finalizes.
  await daemonStart;
  await finalizeWhenHealthy();

  shellWindow.window.on('close', (event) => {
    if (finalExit) return;
    event.preventDefault();
    // The shell never hides while a quit is pending; the drain dialog or the
    // final teardown owns every surface.
    if (quitController?.isQuitting()) return;
    shellWindow?.window.hide();
  });

  /**
   * Graph-Wren entity windows are general Desktop windows owned by the shared
   * window owner, so their visibility follows the Pet's overall visibility and
   * its own entity toggle without rebuilding the Pet runtime.
   */
  const syncTaskgraphEntityVisibility = (): void => {
    const pet = settingsStore.load().pet;
    windowOwner.setEntitiesVisible(pet.visible && pet.entities.taskgraphs);
  };

  desktopTray = createDesktopTray({
    getPetConfig: () => petController!.getConfig(),
    setPetEntityVisibility: (key, visible) => {
      // Every tray action is inert for the whole pending quit, not only modal.
      if (quitController?.isQuitting()) return Promise.resolve();
      if (key === 'taskgraphs') {
        const pet = settingsStore.load().pet;
        settingsStore.patch('pet', {
          ...pet,
          entities: { ...pet.entities, taskgraphs: visible },
        });
        syncTaskgraphEntityVisibility();
        return Promise.resolve();
      }
      return petController!.setEntityVisibility(key, visible);
    },
    selectPetDisplay: (displayId) => (quitController?.isQuitting()
      ? Promise.resolve()
      : petController!.selectDisplay(displayId)),
    setPetEnabled: async (enabled) => {
      if (quitController?.isQuitting()) return;
      await petController!.setVisible(enabled);
      syncTaskgraphEntityVisibility();
    },
    restartPet: () => (quitController?.isQuitting() ? Promise.resolve() : petController!.restart()),
    openDesktop: () => showDesktop('session'),
    getQuotaSnapshot: () => quotaController!.snapshot(),
  }, process.platform);

  if (openSettingsOnReady) {
    openSettingsOnReady = false;
    shellWindow.setPage('settings', false);
  }

  if (SMOKE) {
    await runSmoke(shellWindow);
    console.log('[wrenyard-desktop] smoke ok');
    // Real explicit quit: skip the drain dialog but run the production teardown.
    if (quitController) quitController.requestQuit({ bypassDrain: true });
    else void finalizeQuit();
  }
}

app.on('second-instance', (_event, commandLine) => {
  // A second instance only raises the blocking drain dialog.
  if (quitController?.handleSecondInstance()) return;
  showDesktop(commandLine.some(isSettingsLaunchRequest) ? 'settings' : 'session');
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (isSettingsLaunchRequest(url)) showDesktop('settings');
});

app.on('activate', () => {
  if (quitController?.isQuitting()) return;
  showDesktop('session');
});

// Closing every window only hides it to the tray on every platform. The app
// stays resident (and keeps the daemon it supervises running) until the user
// explicitly quits from the tray menu, so this handler must never app.quit().
app.on('window-all-closed', () => {
  // Tray-resident: no platform quits on the last window close.
});

// Windows delivers OS shutdown/logout as a per-window session event, so every
// created BrowserWindow forwards it to the forced, dialog-free quit path. A
// connected external daemon is never stopped, even here.
app.on('browser-window-created', (_event, window) => {
  // Every window (shell, Pet, TaskGraph, dialogs) inherits the resolved
  // background, Windows title bar palette and window icon.
  appearanceController?.applyToWindow(window);
  if (quitSurfacesBlocked) window.setEnabled(false);
  const onSessionEnd = (): void => { blockQuitSurfaces(); quitController?.forceQuit(); };
  window.on('query-session-end', (event) => { event.preventDefault(); onSessionEnd(); });
  window.on('session-end', onSessionEnd);
});

app.on('before-quit', (event) => {
  // Only the final exit issued from finalizeQuit may proceed; every other
  // before-quit is prevented for as long as the quit controller is pending, so
  // a second request can never bypass draining.
  if (finalExit) return;
  event.preventDefault();
  blockQuitSurfaces();
  if (quitController) quitController.requestQuit();
  else void finalizeQuit();
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Never register the OS URL scheme during smoke: it would point the host's
  // Launch Services / registry at the disposable packaged app path.
  if (app.isPackaged && !SMOKE) app.setAsDefaultProtocolClient('wrenyard');
  void bootstrap().catch(async (error) => {
    console.error('[wrenyard-desktop] startup failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    try {
      quotaController?.stop();
      quotaController = null;
      appearanceController?.dispose();
      appearanceController = null;
      updateController?.stop();
      updateController = null;
      daemonSupervisor?.dispose();
      daemonSupervisor = null;
      await petController?.stop();
      desktopSubscriptions?.dispose();
      desktopSubscriptions = null;
      taskgraphWindowOwner?.destroy();
      taskgraphWindowOwner = null;
      await sessionRegistration?.close();
      sessionRegistration = null;
    } catch {
      // best-effort termination
    }
    app.exit(1);
  });
}
