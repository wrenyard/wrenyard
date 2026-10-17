import { app, BrowserWindow, dialog, ipcMain, Menu, Notification as ElectronNotification, powerMonitor, screen, session, shell, type MessageBoxOptions, type WebContents } from 'electron';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer as createNetServer, connect as connectNet, type Server as NetServer, type Socket as NetSocket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { WrenyardIpcClient, resolveWrenyardIpcPath, WrenyardRpcError, type WrenyardGatewayConnection } from '@wrenyard/control';
import { registerSession, type SessionRegistration } from './session/ipc.js';
import { SessionSeenStore } from './session/seen-store.js';
import { createDesktopTray, type DesktopTrayHandle } from './desktop-tray.js';
import { ensureDesktopActivationPolicy } from './desktop-activation-policy.js';
import {
  DesktopPetController,
  DesktopPetRuntime,
  broadcastPetAppearance,
  createTaskGraphWindows,
  type TaskGraphWindowsHandle,
} from './pet/main/controller.js';
import { DesktopSettingsStore } from './main/settings/desktop-settings.js';
import { DesktopPreferencesController } from './main/settings/preferences.js';
import { DesktopAppearanceController } from './main/appearance.js';
import { WrenyardDaemonClient } from './main/daemon-client/client.js';
import { DaemonSubscriptions } from './main/daemon-client/subscriptions.js';
import { reorderProviders } from './provider-order.js';
import { DesktopQuotaController } from './quota-controller.js';
import { DesktopQuotaSource } from './quota-service.js';
import { ActivityStatusProjector, TaskRunLifecycleTracker } from './main/activity-status.js';
import { ProviderService } from './provider-service.js';
import { buildSettingsSnapshot, type HealthSnapshot } from './settings-snapshot.js';
import { readStatsSnapshot } from './stats-snapshot.js';
import { SHELL_CHANNELS, APPEARANCE_ZOOM_STEP, isSettingsLaunchRequest, type DaemonLifecycleSnapshot, type ExecEventsRequest, type ExecEventsResult, type ExecSnapshotDto, type ExecStartRequest, type PetCompanionSettings, type PreferenceId, type RemoteConnectionTestInput, type RemoteConnectionTestResult, type RemoteConnectionSnapshot, type RemoteHostListResult, type RemoteHostMutationResult, type RemoteHostView, type RuntimeAliasPutRequest, type RuntimeAliasRemoveRequest, type RuntimeAliasSnapshot, type AgentMethod, type ShellPage, type TaskRoutingTestParams, type TaskRoutingTestResult, type TaskRoutingTestTasksResult, type TaskSettingsSaveRequest, type TaskSettingsSnapshot, type WorkspaceConfigurationSnapshot, type WorkspaceSwitchOutcome, type OperationComponentAction, type OperationComponentId, type OperationComponentSnapshot, type BotMethod } from './shell-contract.js';
import { ShellWindowController } from './shell-window.js';
import { MiniCardManager } from './mini-cards.js';
import { Notifier } from './main/notifications/notifier.js';
import { createInAppChannel } from './main/notifications/channels/in-app.js';
import { createPetChannel } from './main/notifications/channels/pet.js';
import { createSystemChannel } from './main/notifications/channels/system.js';
import { createTaskNotifier } from './main/notifications/task.js';
import { createTaskGraphNotifier } from './main/notifications/taskgraph.js';
import { createSessionNotifier } from './main/notifications/session.js';
import { createQuotaNotifier } from './main/notifications/quota.js';
import { createDaemonNotifier } from './main/notifications/daemon.js';
import { createInterfaceZoom } from './main/zoom.js';
import { DesktopUpdateController } from './updater/controller.js';
import { DesktopDaemonSupervisor } from './daemon-supervisor.js';
import { probeWrenyard as probeDaemon } from './daemon-health.js';
import { createPageLoader, preloadPath } from './pages.js';
import { createQuitController, type QuitController, type QuitCounts, type QuitDialogHandle } from './quit-controller.js';
import { resolveDesktopBuildTime } from './build-metadata.js';
import { desktopMenuTemplate } from './app-menu.js';
import { packagedDaemonLaunch } from '../../daemon/lib/daemon/launch.mts';
import { resolveWrenyardConfigPath as resolveForemanConfigPath, resolveWrenyardDesktopDataDir } from '@wrenyard/paths';
import { getTheme } from '@wrenyard/themes';
import { foremanStateRoot } from '../../daemon/lib/config/state.mts';
import {
  createMacQuitConfirmationGate,
  type QuitOrigin,
} from './desktop-interaction-policy.js';
import {
  initializeProductWorkspace,
  inspectProductWorkspace,
} from './workspace.js';
import { assertDaemonIdle } from './workspace-activation.js';
import { bootstrapRemoteDaemon } from './main/remote/bootstrap.js';
import { readLinuxOpenAtLogin, setLinuxOpenAtLogin } from './linux-autostart.js';
import { armLinuxGpuFallback, enableLinuxSoftwareRenderingIfNeeded } from './linux-gpu.js';
import { ActiveConnectionContext, ConnectionBusyError, type ActiveConnectionSnapshot } from './main/remote/context.js';
import {
  appendSshHostStanza,
  listLocalSshHosts,
  probeSshHost,
  resolveDefaultSshConfigPath,
  restoreSshHostStanza,
  validateSshAlias,
  validateSshCandidate,
  withCandidateConfig,
  type SshStanzaRollback,
} from './main/remote/ssh-discovery.js';
import { SshRelay, type RemotePlatform } from './main/remote/ssh-relay.js';

// Isolate Electron's data directories before any session/BrowserWindow or the
// single-instance lock is created when a private state root is requested.
// `setPath` requires the target to exist, so create it first. `sessionData`
// must be relocated explicitly: Chromium cache/network storage is not moved
// by setting `userData` alone. Linux always shares the daemon state root
// (`<state>/desktop`); other platforms keep Electron defaults unless an
// override is set.
const explicitDesktopData = process.env.WRENYARD_DESKTOP_USER_DATA?.trim();
if (explicitDesktopData || process.env.WRENYARD_STATE_HOME?.trim() || process.platform === 'linux') {
  const desktopDataDir = explicitDesktopData ? resolve(explicitDesktopData) : resolveWrenyardDesktopDataDir();
  mkdirSync(desktopDataDir, { recursive: true });
  app.setPath('userData', desktopDataDir);
  app.setPath('sessionData', desktopDataDir);
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'wrenyard-desktop');
  enableLinuxSoftwareRenderingIfNeeded(app.getPath('userData'));
  armLinuxGpuFallback(app.getPath('userData'));
}

const SMOKE = process.env.WRENYARD_DESKTOP_SMOKE === '1' || process.argv.includes('--smoke');
const FOREMAN_HEALTH_TIMEOUT_MS = 5_000;
/** Task definition enumeration may cold-load the workspace and model catalog. */
const TASK_SETTINGS_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Operation-component reads run both health checks on the first call, so they
 * use a longer budget than a routine settings request.
 */
const OPERATION_COMPONENTS_REQUEST_TIMEOUT_MS = 90_000;
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

/** Human-readable message for a thrown value crossing an IPC boundary. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/**
 * Structured outcome of the daemon's `workspace.switch` method. Desktop applies
 * a workspace change through that method while the daemon keeps running, and
 * surfaces the daemon's refusal reason verbatim; the daemon owns the
 * authoritative `workspace.root` write.
 */
interface DaemonWorkspaceSwitchResult {
  ok: boolean;
  outcome: WorkspaceSwitchOutcome;
  workspace_root?: string;
  message?: string;
}

/** Remote-safe result of the daemon's `workspace.inspect` method. */
interface DaemonWorkspaceInspectResult {
  ok: boolean;
  outcome: 'configured' | 'missing' | 'invalid';
  root: string;
  exists: boolean;
  readOnly: boolean;
  message?: string;
}

/** Remote-safe result of the daemon's `workspace.initialize` method. */
interface DaemonWorkspaceInitializeResult {
  ok: boolean;
  outcome: 'initialized' | 'exists' | 'busy' | 'invalid' | 'unavailable' | 'error';
  root?: string;
  message?: string;
}

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
      const identity = 'identity' in result ? result.identity : undefined;
      const runtimeMode = identity != null && typeof identity === 'object' && 'mode' in identity
        && (identity.mode === 'source' || identity.mode === 'installed') ? identity.mode : undefined;
      return { connected: true, ...(runtimeMode ? { runtimeMode } : {}), ...(uptimeMs !== undefined ? { uptimeMs } : {}) };
    }
    return { connected: true };
  } catch {
    return { connected: false };
  } finally {
    await client?.close?.();
  }
}

const probeWrenyard = (path: string) => probeDaemon(path, app.getVersion());

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
 * Desktop-owned stable endpoint that every control consumer points at. It is an
 * owner-only local IPC endpoint (Unix socket or Windows named pipe) bridged to
 * whichever daemon is active: the local daemon, or a remote daemon reached over
 * the SSH relay. Consumers never need to know whether the active endpoint is
 * local or remote; switching only retargets this bridge.
 */
function resolveActiveEndpointPath(ipcPath: string): string {
  if (process.platform === 'win32' || ipcPath.startsWith('\\\\')) {
    return `\\\\.\\pipe\\wrenyard-active-${process.pid}`;
  }
  return join(dirname(ipcPath), `wrenyard-active-${process.pid}.sock`);
}

/**
 * Byte-forwarding bridge. It never parses the NDJSON stream: frames, the
 * protocol-v2 handshake, timeouts and cancellation pass through untouched.
 * Retargeting drops every live connection so old clients and long polls are
 * invalidated rather than silently reading the previous context's data.
 */
class ActiveEndpointBridge {
  private server: NetServer | null = null;
  private target: string;
  private readonly connections = new Set<NetSocket>();

  constructor(private readonly bridgePath: string, target: string) {
    this.target = target;
  }

  get endpoint(): string {
    return this.bridgePath;
  }

  async start(): Promise<void> {
    if (process.platform !== 'win32' && existsSync(this.bridgePath)) {
      try { unlinkSync(this.bridgePath); } catch { /* best effort */ }
    }
    this.server = createNetServer((socket) => this.forward(socket));
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.bridgePath, () => resolveStart());
    });
  }

  setTarget(target: string): void {
    this.target = target;
    this.dropConnections();
  }

  private forward(socket: NetSocket): void {
    this.connections.add(socket);
    const upstream = connectNet(this.target);
    const closeBoth = (): void => {
      socket.destroy();
      upstream.destroy();
      this.connections.delete(socket);
    };
    socket.on('error', closeBoth);
    upstream.on('error', closeBoth);
    socket.on('close', closeBoth);
    upstream.on('close', closeBoth);
    socket.pipe(upstream);
    upstream.pipe(socket);
  }

  dropConnections(): void {
    for (const connection of [...this.connections]) connection.destroy();
    this.connections.clear();
  }

  async stop(): Promise<void> {
    this.dropConnections();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
    if (process.platform !== 'win32' && existsSync(this.bridgePath)) {
      try { unlinkSync(this.bridgePath); } catch { /* best effort */ }
    }
  }
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
        `['[data-titlebar]', '[data-statusbar]'].every((selector) => {
          const root = document.querySelector(selector);
          if (!(root instanceof HTMLElement)) return false;
          const box = root.getBoundingClientRect();
          const style = getComputedStyle(root);
          return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        })`,
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
    shell.setPage('tasks', false);
    const tasksVisible = await waitForVisiblePageRoot(shell, 'tasks');
    shell.setPage('agents', false);
    const agentsVisible = await waitForVisiblePageRoot(shell, 'agents');
    shell.setPage('session', false);
    const sessionVisible = await waitForVisiblePageRoot(shell, 'session');
    if (!shellOk || !snapshotOk || !quotaOk || !tasksOk || !routingOk || !statsOk || !settingsVisible || !statsVisible || !tasksVisible || !agentsVisible || !sessionVisible) {
      throw new Error(
        `smoke failed (shell=${shellOk}, snapshot=${snapshotOk}, quota=${quotaOk}, tasks=${tasksOk}, routing=${routingOk}, stats=${statsOk}, settings=${settingsVisible}, statsPage=${statsVisible}, tasksPage=${tasksVisible}, agentsPage=${agentsVisible}, session=${sessionVisible})`,
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
/** Stable active-endpoint bridge and the single active-connection context (WY Remote). */
let activeEndpointBridge: ActiveEndpointBridge | null = null;
let connectionContext: ActiveConnectionContext | null = null;
/** Live SSH relay while a remote connection is active; null while local. */
let activeSshRelay: SshRelay | null = null;
let shellWindow: ShellWindowController | null = null;
/** Mini-card window owner; null until bootstrap creates it. */
let miniCards: MiniCardManager | null = null;
/** Live settings store, read by the notifier's `notifications.enabled` gate. */
let desktopSettingsStore: DesktopSettingsStore | null = null;
let desktopTray: DesktopTrayHandle | null = null;
let petController: DesktopPetController | null = null;
let desktopSubscriptions: DaemonSubscriptions | null = null;
let taskgraphWindowOwner: TaskGraphWindowsHandle | null = null;
let quotaController: DesktopQuotaController | null = null;
let appearanceController: DesktopAppearanceController | null = null;
let preferencesController: DesktopPreferencesController | null = null;
let updateController: DesktopUpdateController | null = null;
let daemonSupervisor: DesktopDaemonSupervisor | null = null;
/** Latest known product workspace; refreshed when a save activates a new root. */
let workspaceConfiguration: WorkspaceConfigurationSnapshot | null = null;
let daemonRunning = false;
/**
 * Business requests are allowed only against a committed endpoint: the local
 * daemon while it supervises/runs, or a fully switched remote. `connecting` and
 * `disconnected` are denied, so a request can neither race a half-open target
 * nor be sent to a lost endpoint.
 */
const allowsBusinessOperations = (): boolean => connectionContext?.allowsBusinessOperations() ?? true;
/**
 * True whenever the active host context is *not* the local daemon: a switch in
 * progress, a committed remote, or a lost remote tunnel. Local paths and
 * local-only actions must never run in any of those states.
 */
const isNonLocalContext = (): boolean => !(connectionContext?.isLocal() ?? true);
const isCommittedRemote = (): boolean => connectionContext?.isRemote() === true;
const canConnectDaemon = (): boolean =>
  allowsBusinessOperations() && (isCommittedRemote() || daemonSupervisor?.snapshot().state === 'running');
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

/** Interface zoom (clamp/apply/persist) lives in its own module. */
const interfaceZoom = createInterfaceZoom({
  getShellWindow: () => shellWindow,
  getAppearanceController: () => appearanceController,
  getPreferencesController: () => preferencesController,
});

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
 * Push the committed remote-connection state to the renderer so every
 * endpoint-bound view (session/draft/task/project/provider/quota/statistics/
 * Pet) resets together on a local↔remote switch.
 */
function notifyRemoteChanged(): void {
  if (shellWindow && !shellWindow.window.isDestroyed()) {
    const snapshot: ActiveConnectionSnapshot = connectionContext?.snapshot() ?? { state: 'local', generation: 0, host: null };
    shellWindow.window.webContents.send(SHELL_CHANNELS.remoteChanged, snapshot);
  }
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
    // Stop only the relay/daemon processes this app started: the SSH relay and
    // the local active-endpoint bridge. An externally owned remote daemon is
    // left running.
    await activeSshRelay?.stop();
    activeSshRelay = null;
    await activeEndpointBridge?.stop();
    activeEndpointBridge = null;
    connectionContext = null;
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

/**
 * The trusted shell surfaces: the shell window plus every open mini card, in
 * that order. This single predicate backs both the shell IPC assertion and the
 * session relay's sender check, so trust cannot drift between them.
 */
function trustedShellSurfaces(): WebContents[] {
  const surfaces: WebContents[] = [];
  if (shellWindow && !shellWindow.window.isDestroyed()) surfaces.push(shellWindow.window.webContents);
  surfaces.push(...(miniCards?.cardWebContents() ?? []));
  return surfaces;
}

function isTrustedShellSender(sender: WebContents): boolean {
  return trustedShellSurfaces().some((surface) => surface.id === sender.id);
}

/**
 * Validate a renderer-supplied quota focus at the IPC boundary. `null`/absent
 * clears the focus; an id-less or oversized payload is rejected as no focus.
 */
function normalizeQuotaFocus(value: unknown): { id: string; label?: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return null;
  const label = record.label;
  return typeof label === 'string' && label.length > 0 && label.length <= 256 ? { id, label } : { id };
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
 * Make the menu and Pet/graph entity surfaces inert for the *entire* pending
 * quit, not only while the drain dialog is open: the application menu is
 * removed and the Pet/graph entity windows are hidden. Native window disabling
 * is deferred until a drain dialog is actually needed (see
 * createQuitDialogPresenter). The stored menu and geometry are restored only if
 * the quit never happens.
 */
function blockQuitSurfaces(): void {
  if (quitSurfacesBlocked) return;
  quitSurfacesBlocked = true;
  preQuitMenu = Menu.getApplicationMenu();
  Menu.setApplicationMenu(null);
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
 * Transient macOS Cmd+Q hint (Chrome-style "Hold ⌘Q to quit" overlay). Unlike
 * the blocking drain dialog this is a small, non-interactive, transparent card
 * that follows the current Desktop appearance and disappears on its own, so it
 * never steals focus or blocks the quit.
 */
const QUIT_HINT_HTML = (background: string, foreground: string, border: string): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:500}
.card{padding:14px 22px;border-radius:12px;border:1px solid ${border};background:${background};color:${foreground};box-shadow:0 2px 8px rgba(0,0,0,.22)}
</style></head><body><div class="card">再次按下 ⌘Q 退出啾啾工坊</div></body></html>`;

let quitHintWindow: BrowserWindow | null = null;
let quitHintTimer: ReturnType<typeof setTimeout> | null = null;

/** Tear down the transient hint card, if one is still on screen. */
function dismissQuitHint(): void {
  if (quitHintTimer) {
    clearTimeout(quitHintTimer);
    quitHintTimer = null;
  }
  const window = quitHintWindow;
  quitHintWindow = null;
  if (window && !window.isDestroyed()) window.destroy();
}

/**
 * Show the macOS "press ⌘Q again" hint as a small, non-interactive card that
 * follows the current appearance. Colors come from the same `getTheme().modes`
 * metadata `appearance.ts` uses: the mode definition only exposes
 * `windowBackground` and the title-bar palette, so the card background uses
 * `windowBackground`, the text uses `titleBarOverlay.symbolColor`, and the border
 * uses a mode-appropriate translucent value. Falls back to dark when no
 * appearance controller is available yet. `attach` is deliberately skipped: it
 * would paint an opaque background over this transparent, 3s-only window.
 */
function showQuitHint(): void {
  dismissQuitHint();
  const resolved = appearanceController?.resolve();
  const mode = resolved ? getTheme(resolved.theme).modes[resolved.dark ? 'dark' : 'light'] : null;
  const dark = resolved ? resolved.dark : true;
  const background = mode?.windowBackground ?? '#1f1f24';
  const foreground = mode?.titleBarOverlay.symbolColor ?? '#f2f2f5';
  const border = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.12)';
  const width = 300;
  const height = 72;
  const window = new BrowserWindow({
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  quitHintWindow = window;
  // Center over the shell window when it is on screen, otherwise over the
  // display under the cursor.
  const parent = shellWindow?.window;
  const anchor = parent && !parent.isDestroyed() && parent.isVisible()
    ? parent.getBounds()
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  window.setBounds({
    x: Math.round(anchor.x + (anchor.width - width) / 2),
    y: Math.round(anchor.y + (anchor.height - height) / 2),
    width,
    height,
  });
  // Never interactive and never focus-stealing: show without activating.
  window.setIgnoreMouseEvents(true);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive(); });
  window.on('closed', () => { if (quitHintWindow === window) quitHintWindow = null; });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(QUIT_HINT_HTML(background, foreground, border))}`);
  quitHintTimer = setTimeout(() => {
    quitHintTimer = null;
    if (!window.isDestroyed()) window.destroy();
  }, 3_000);
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
      // Native window disabling is deferred until a drain dialog is actually
      // needed: `setEnabled(false)` blocks the main thread for ~270ms per window
      // on macOS, so doing it on the idle quit path stalled the quit for no
      // benefit. Disable the pre-existing windows before creating the dialog so
      // the dialog itself stays enabled.
      for (const existing of BrowserWindow.getAllWindows()) {
        if (!existing.isDestroyed()) existing.setEnabled(false);
      }
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
      // The drain dialog is a themed window; register it so a theme change
      // re-applies in place. Transparent Pet overlays are never attached.
      appearanceController?.attach(window);
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
  const configPath = resolveForemanConfigPath();
  const ipcPath = resolveWrenyardIpcPath(process.env, { configPath });
  // Single stable active endpoint every control consumer points at. It is
  // bridged to the local daemon at boot and retargeted to the SSH relay when a
  // remote connection becomes active, so consumers follow the active context
  // without knowing which daemon is behind it.
  const activeEndpointPath = resolveActiveEndpointPath(ipcPath);
  activeEndpointBridge = new ActiveEndpointBridge(activeEndpointPath, ipcPath);
  await activeEndpointBridge.start();
  const pageLoader = createPageLoader({ appPath: app.getAppPath(), packaged: app.isPackaged, env: process.env });
  workspaceConfiguration = await inspectProductWorkspace();
  console.info('[wrenyard-desktop] workspace ready');

  const requestForeman = async (method: string, params: unknown): Promise<unknown> => {
    requireDaemonRunning();
    // Generation fencing: a reply that resolves after a connection switch is
    // discarded instead of leaking the previous context's data into a view.
    const generation = connectionContext?.currentGeneration() ?? 0;
    const client = new WrenyardIpcClient({ path: activeEndpointPath, requestTimeoutMs: TASK_SETTINGS_REQUEST_TIMEOUT_MS });
    try {
      const result = await client.request(method, params);
      connectionContext?.assertCurrent(generation);
      return result;
    } finally {
      await client.close?.();
    }
  };
  // Host-registry management always targets the local daemon: the saved-host
  // registry is owned by the originating machine, not by the active remote.
  const requestLocalDaemon = async (method: string, params: unknown): Promise<unknown> => {
    const client = new WrenyardIpcClient({ path: ipcPath, requestTimeoutMs: TASK_SETTINGS_REQUEST_TIMEOUT_MS });
    try {
      return await client.request(method, params);
    } finally {
      await client.close?.();
    }
  };
  /**
   * Read the endpoint the app is *leaving*, without the business-operation gate.
   * Only the pre-switch idle check uses this: it runs while the state is already
   * `connecting` (so business requests are denied) but must still target the
   * previous endpoint, never the not-yet-committed candidate. The stable bridge
   * has not been retargeted yet at that point.
   */
  const requestLeavingEndpoint = async (method: string, params: unknown): Promise<unknown> => {
    const client = new WrenyardIpcClient({ path: activeEndpointPath, requestTimeoutMs: TASK_SETTINGS_REQUEST_TIMEOUT_MS });
    try {
      return await client.request(method, params);
    } finally {
      await client.close?.();
    }
  };

  /**
   * Re-read the active workspace. A local context reads the local config; a
   * non-local context reads the daemon's remote-safe `workspace.inspect`, so a
   * remote path is never stat'ed on the local machine and there is no implicit
   * local inspection. Callers only reach the remote branch while the endpoint is
   * committed, so the request never targets a half-open or lost endpoint.
   */
  const readActiveWorkspaceSnapshot = async (): Promise<WorkspaceConfigurationSnapshot> => {
    if (!isNonLocalContext()) return inspectProductWorkspace();
    const result = await requestForeman('workspace.inspect', {}) as DaemonWorkspaceInspectResult;
    return {
      status: result.outcome,
      source: 'user-config',
      configPath,
      ...(result.root ? { path: result.root } : {}),
      ...(result.message ? { message: result.message } : {}),
      readOnly: result.readOnly,
    };
  };

  /**
   * Reset session selection, drafts and every data cache together on a context
   * transition, then notify the surfaces.
   *
   * The ordering is explicit and every step is awaited, so a caller awaiting
   * this observes the real end state rather than a placeholder completion:
   * subscriptions first (reconnect when the endpoint is committed, pause when it
   * is not), then the session ledger polls, then the renderer's session
   * selection and composer draft, then the workspace snapshot, then the change
   * notifications. While the endpoint is unsettled nothing is fetched: no
   * request is sent to the previous or to a lost endpoint, and no local
   * inspection runs in a non-local context.
   */
  const refreshActiveContext = async (reason: string): Promise<void> => {
    // Fence the whole refresh to the generation it started under: if a newer
    // transition (or a tunnel loss) supersedes it while it awaits, it must not
    // apply a stale workspace snapshot or push a stale context to the renderer,
    // and it never refetches anything from the previous endpoint (every read
    // below resolves against the current active endpoint at call time).
    const generation = connectionContext?.currentGeneration() ?? 0;
    const settled = canConnectDaemon();
    if (settled) desktopSubscriptions?.setEndpoint(activeEndpointPath);
    else desktopSubscriptions?.pause();
    sessionRegistration?.reset();
    // Drop the cached quota/provider business snapshots (and the Pet projection
    // built from them) immediately, rather than exposing the previous context's
    // numbers until a refetch lands.
    quotaController?.resetSnapshots();
    shellWindow?.deliverCommandAction({ id: 'session.newDraft' });
    if (settled) {
      try {
        const snapshot = await readActiveWorkspaceSnapshot();
        if (!(connectionContext?.isCurrent(generation) ?? true)) return;
        workspaceConfiguration = snapshot;
      } catch (error) {
        console.warn('[wrenyard-desktop] workspace re-read after context change failed:', messageOf(error));
      }
    }
    if (!(connectionContext?.isCurrent(generation) ?? true)) return;
    notifyDaemonChanged();
    notifyRemoteChanged();
    shellWindow?.notifyQuotaChanged();
    console.info('[wrenyard-desktop] active context changed:', reason);
  };

  /**
   * Authoritative pre-switch check: the daemon that is currently active must
   * have no admitted work. The shared activity cache only tracks
   * tasks/taskgraphs, so it is not sufficient — this reads `daemon.status`
   * itself, whose `idle` flag accounts for tasks, taskgraphs, executions and
   * sessions. It runs before anything is provisioned or persisted, so a refusal
   * leaves no trace.
   *
   * `check` is false only when the leaving context is itself unsettled (a lost
   * remote tunnel): there is then no reachable daemon whose work could be
   * harmed, and refusing would make a re-connect impossible.
   */
  const assertActiveContextIdle = async (check: boolean): Promise<void> => {
    if (!check) return;
    const status = await requestLeavingEndpoint('daemon.status', {});
    const counts = (status ?? {}) as Record<string, unknown>;
    const activeTaskGraphs = typeof counts.activeTaskGraphCount === 'number' ? counts.activeTaskGraphCount : 0;
    if (!assertDaemonIdle(status).idle || activeTaskGraphs > 0) {
      throw new ConnectionBusyError('当前有任务正在进行，完成后才能切换连接');
    }
  };

  /**
   * Surface an SSH-config rollback conflict instead of swallowing it: when the
   * appended `Host` stanza could not be rewound (the file changed underneath
   * us), the user has to resolve the leftover configuration by hand.
   */
  const withSshRollbackNote = (error: unknown, rollbackError: unknown): Error => {
    const base = error instanceof Error ? error : new Error(messageOf(error));
    if (rollbackError === null || rollbackError === undefined) return base;
    return new Error(`${base.message}；SSH 配置回滚失败：${messageOf(rollbackError)}`);
  };

  /**
   * Real user work still in flight, read from the shared activity round:
   * queued/running task runs and live task graphs. A connection switch waits
   * for this instead of killing the user's work.
   */
  const hasActiveAppWork = (): boolean => {
    const presence = desktopSubscriptions?.activity();
    if (!presence) return false;
    return presence.tasks.length > 0 || presence.taskgraphs.length > 0;
  };

  // The one active-connection context. Its applyEndpoint retargets the single
  // stable bridge; its resetCaches resets every endpoint-bound surface together.
  connectionContext = new ActiveConnectionContext({
    localEndpoint: ipcPath,
    applyEndpoint: (endpoint) => {
      // Retarget the single stable bridge. Every control consumer resolves
      // through it, and dropping the live sockets invalidates old clients and
      // long polls instead of letting them keep reading the previous context.
      activeEndpointBridge?.setTarget(endpoint);
    },
    // Always awaited, so a caller sees the real end of the reset sequence rather
    // than a fire-and-forget placeholder. The underlying error is logged here
    // and then rethrown so the context can surface it on the committed remote;
    // the context never rolls back a switch that already persisted.
    resetCaches: async ({ reason }) => {
      try {
        await refreshActiveContext(reason);
      } catch (error) {
        console.warn('[wrenyard-desktop] active context refresh failed:', messageOf(error));
        throw error;
      }
    },
    onStateChange: () => { notifyDaemonChanged(); notifyRemoteChanged(); },
    hasActiveOperations: () => hasActiveAppWork(),
  });
  // One Notifier for the whole process, gated by `notifications.enabled`.
  // Each producer states its channels explicitly; the notifier holds no state
  // of its own and the in-app channel owns the history.
  const inAppChannel = createInAppChannel({ getShellWindow: () => shellWindow });
  const notifier = new Notifier({
    isEnabled: () => desktopSettingsStore?.load().notifications.enabled ?? true,
    inApp: inAppChannel,
    pet: createPetChannel({ showBubble: (broadcast) => petController?.showBroadcast(broadcast) }),
    system: createSystemChannel({
      notificationConstructor: ElectronNotification,
      isWindowFocused: () => Boolean(
        shellWindow && !shellWindow.window.isDestroyed() && shellWindow.window.isFocused(),
      ),
      showDesktop: () => showDesktop(),
      getShellWindow: () => shellWindow,
    }),
  });
  const taskNotifier = createTaskNotifier({ notifier, requestForeman });
  const taskgraphNotifier = createTaskGraphNotifier({ notifier });
  const sessionNotifier = createSessionNotifier({ notifier });
  const quotaNotifier = createQuotaNotifier({ notifier });
  const daemonNotifier = createDaemonNotifier({ notifier });
  // The updater lifecycle stays local: it must observe and stop the daemon this
  // Desktop owns, never a remote daemon reached through the active endpoint.
  const readUpdateDaemonIdle = async (): Promise<boolean | null> => {
    try {
      return assertDaemonIdle(await requestLocalDaemon('daemon.status', {})).idle;
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
  // Bot-agent transport. Desktop forwards the allowlisted `agent.*` and
  // `routine.*` calls to the daemon and returns their results unchanged; it
  // never wakes a bot or manages a routine itself.
  const requestAgent = async (method: AgentMethod, params?: unknown): Promise<unknown> => {
    return await requestForeman(method, params);
  };
  // Bot-mode transport. Desktop forwards the allowlisted `bot.*` calls to the
  // daemon and returns their results unchanged; it never runs a bot step or
  // decides an item's state itself.
  const requestBot = async (method: BotMethod, params?: unknown): Promise<unknown> => {
    return await requestForeman(method, params);
  };
  // Operation-component transport. The daemon owns installation, authorization
  // and health checks for its own machine; Desktop only forwards the read and
  // the user-triggered action. A dedicated client with a longer budget is used
  // because the first read runs both component health checks.
  const requestOperationComponents = async (method: string, params: unknown): Promise<unknown> => {
    requireDaemonRunning();
    const client = new WrenyardIpcClient({ path: ipcPath, requestTimeoutMs: OPERATION_COMPONENTS_REQUEST_TIMEOUT_MS });
    try {
      return await client.request(method, params);
    } finally {
      await client.close?.();
    }
  };
  const getOperationComponents = async (): Promise<OperationComponentSnapshot[]> => {
    const result = (await requestOperationComponents('components.list', {})) as { components: OperationComponentSnapshot[] };
    return result.components;
  };
  const runOperationComponentAction = async (
    id: OperationComponentId,
    action: OperationComponentAction,
  ): Promise<OperationComponentSnapshot> => {
    const result = (await requestOperationComponents('components.action', { id, action })) as { component: OperationComponentSnapshot };
    return result.component;
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
    launch: app.isPackaged ? packagedDaemonLaunch(join(process.resourcesPath, 'wrenyard'), configPath) : null,
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
      daemonNotifier.observe(snapshot);
      void finalizeWhenHealthy();
    },
  });
  const daemonStart = daemonSupervisor.start().catch((error: unknown) => {
    console.warn('[wrenyard-desktop] daemon start failed:', error instanceof Error ? error.message : String(error));
  });
  // Initial page reads must wait for the owned daemon startup to settle.
  await daemonStart;
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

  // Shared "seen" state for the 新结果 dot, stored next to the Desktop settings
  // file in the same state/config directory (resolved as `settings.json` below).
  const sessionSeenStore = new SessionSeenStore(join(app.getPath('userData'), 'session-seen.json'));

  // Relay session IPC over the same owner-only daemon control socket.
  sessionRegistration = registerSession({
    ipcPath: activeEndpointPath,
    canConnect: canConnectDaemon,
    // Media and local-only actions are remote-safe whenever the host context is
    // not local (connecting/disconnected/remote alike): picked/clipboard bytes
    // become bounded dataUrl uploads and a remote canonical path is never
    // revealed locally.
    isRemote: () => isNonLocalContext(),
    // Drop a session reply whose connection generation a switch superseded.
    currentGeneration: () => connectionContext?.currentGeneration() ?? 0,
    // Shared seen state behind the 新结果 dot; every trusted window reads it.
    seenStore: sessionSeenStore,
    // The shell window and the mini-card owner are created after this
    // registration, so resolve both live on each call instead of capturing them.
    isShellSender: (sender) => isTrustedShellSender(sender),
    // Every trusted surface also receives each polled live event, so a card sees
    // live chat updates even while another window owns the session's poll.
    additionalRecipients: () => trustedShellSurfaces(),
    // Live ledger events feed the conversation notification producer; the
    // initial catch-up page is never replayed.
    onLiveEvent: (sessionId, event) => sessionNotifier.observe(sessionId, event),
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const petAssets = resolvePetAssets();
  const settingsPath = join(app.getPath('userData'), 'settings.json');
  console.info(`[wrenyard-desktop] settings path: ${settingsPath}`);
  const settingsStore = new DesktopSettingsStore({
    path: settingsPath,
    onChange: () => {
      desktopTray?.rebuild();
      shellWindow?.notifyPreferencesChanged();
      interfaceZoom.applyShellZoom();
      // Open cards follow the same persisted zoom as the shell.
      miniCards?.applyZoomToCards(appearanceController?.zoomFactor() ?? 1);
      // `update.autoCheck` gates the periodic schedule; manual checks always work.
      if (!SMOKE && app.isPackaged) updateController?.setAutoCheck(settingsStore.load().update.autoCheck);
    },
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
    onChanged: (appearance) => {
      shellWindow?.notifyAppearanceChanged(appearance);
      // Pet overlays and the themed transcript mirror the same resolved value.
      broadcastPetAppearance(appearance);
      // Open Mini cards follow the same appearance; they never fall back to a
      // separate default palette.
      miniCards?.notifyAppearanceChanged(appearance);
    },
  });
  appearanceController.init();
  desktopSettingsStore = settingsStore;
  // Single writer for the version 3 preference partitions. Appearance
  // theme/colorMode/motion still flow through the appearance controller so
  // nativeTheme and the resolved push stay in one owner.
  preferencesController = new DesktopPreferencesController({
    store: settingsStore,
    saveAppearance: (patch) => { appearanceController?.save(patch); },
    readOpenAtLogin: () => process.platform === 'linux'
      ? readLinuxOpenAtLogin()
      : app.getLoginItemSettings().openAtLogin,
    setOpenAtLogin: (value) => {
      if (process.platform === 'linux') {
        setLinuxOpenAtLogin(value);
        return;
      }
      if (process.platform !== 'darwin' && process.platform !== 'win32') return;
      app.setLoginItemSettings({ openAtLogin: value });
    },
    onMenuBarQuotaChanged: () => { desktopTray?.rebuild(); },
  });
  // Mini-card mode: the shell's multi-window surface. Each card loads the shell
  // page with `?mini=1`; the shell hides while cards are open and returns when
  // the last one closes. This manager is the single source of card trust.
  miniCards = new MiniCardManager({
    pageLoader,
    preloadPath: preloadPath(app.getAppPath(), 'shell'),
    // Resolve the background and preload arguments when each card opens, not
    // once at startup, so a new or reopened card uses the current appearance.
    backgroundColor: () => appearanceController!.backgroundColor(),
    additionalArguments: () => appearanceController!.arguments(),
    getAppearance: () => appearanceController!.resolve(),
    getShellWindow: () => (shellWindow && !shellWindow.window.isDestroyed() ? shellWindow.window : null),
    hideShell: () => { shellWindow?.window.hide(); },
    showShell: () => showDesktop('session'),
    selectShellSession: (sessionId) => {
      shellWindow?.deliverCommandAction(
        sessionId ? { id: 'session.open', args: sessionId } : { id: 'session.newDraft' },
      );
    },
    // Cards reuse the shell's single zoom source of truth (`appearance.zoom`)
    // through the appearance controller, exactly like applyShellZoom does.
    getZoomFactor: () => appearanceController?.zoomFactor() ?? 1,
  });
  // One shared daemon transport and subscription set for the whole Desktop
  // process. The shell window, tray and Pet all consume the same rounds; the
  // Pet never opens its own connection or timer.
  const daemonClient = new WrenyardDaemonClient({
    path: activeEndpointPath,
    canConnect: canConnectDaemon,
    // Fence every shared reply with the active generation so a result produced
    // on the previous endpoint is discarded after a switch.
    getGeneration: () => connectionContext?.currentGeneration() ?? 0,
  });
  const windowOwner = createTaskGraphWindows({
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
    attachAppearance: (window) => appearanceController?.attach(window),
    logger: console,
  });
  taskgraphWindowOwner = windowOwner;
  desktopSubscriptions = new DaemonSubscriptions({
    client: daemonClient,
    ipcPath: activeEndpointPath,
    getTrackedTaskgraphIds: () => windowOwner.getTrackedTaskgraphIds(),
  });
  if (canConnectDaemon()) desktopSubscriptions.start();
  // The single shared activity round feeds the general TaskGraph windows as
  // well, so Wren entities and Graph Slips stay live even while Pet is hidden.
  // It also feeds the status-bar projection and the main-owned task lifecycle
  // notifications, which must work whether or not Pet is enabled.
  const activityProjector = new ActivityStatusProjector();
  const taskLifecycle = new TaskRunLifecycleTracker();
  desktopSubscriptions.subscribe({
    onActivity: (presence) => {
      windowOwner.applyActivity(presence);
      const changed = activityProjector.update(presence);
      if (changed) shellWindow?.notifyActivityChanged(changed);
      for (const run of taskLifecycle.observe(activityProjector.get())) {
        void taskNotifier.notifyVanishedTaskRun(run);
      }
      taskgraphNotifier.observe(presence);
    },
  });

  petController = new DesktopPetController({
    store: settingsStore,
    createRuntime: (config, onConfigChange) => new DesktopPetRuntime({
      config,
      pageLoader,
      preloadDir: petAssets.preloadDir,
      subscriptions: desktopSubscriptions!,
      onConfigChange,
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
  const providerService = new ProviderService({
    ipcPath: activeEndpointPath,
    canConnect: canConnectDaemon,
    // A provider/quota reply produced on the previous endpoint must not be
    // applied after a switch.
    getGeneration: () => connectionContext?.currentGeneration() ?? 0,
  });
  quotaController = new DesktopQuotaController({
    source: new DesktopQuotaSource(
      activeEndpointPath,
      canConnectDaemon,
      // Fence every quota reply with the active generation so a result produced
      // on the previous endpoint cannot repopulate the cache after a switch.
      () => connectionContext?.currentGeneration() ?? 0,
    ),
    providerSource: providerService,
    getProviderOrder: () => settingsStore.load().providers.providers,
    onChanged: (snapshot, providers) => {
      petController?.setQuotaProviders(providers);
      desktopTray?.rebuild();
      shellWindow?.notifyQuotaChanged();
      quotaNotifier.observe(snapshot);
    },
  });
  // Provider discovery may wait on native clients; it must not delay the window.
  void quotaController.start().catch((error: unknown) => {
    console.warn('[wrenyard-desktop] initial quota refresh failed:', error);
  });

  // The renderer publishes the quota provider of the composer's selected model
  // so Pet can focus it; a null focus clears it when the session unmounts.
  ipcMain.handle(SHELL_CHANNELS.quotaFocus, (event, focus: unknown) => {
    if (!isTrustedShellSender(event.sender)) return;
    petController?.setQuotaFocus(normalizeQuotaFocus(focus));
  });

  // ── WY Remote: host management and active-connection control ──────────
  // The modal/menu bridge. Saved hosts live in the local daemon config and are
  // read/written through the local daemon; discovery, validation and the relay
  // are Desktop-local. Only a validated, compatible, ready connection is saved.
  const sshConfigPath = resolveDefaultSshConfigPath(process.env);

  /**
   * Unique local endpoint per relay attempt: a replacement candidate is started
   * on its own path, so the current relay is never torn down before the new one
   * is ready.
   */
  let relaySequence = 0;
  const nextRelayEndpointPath = (): string => {
    relaySequence += 1;
    return process.platform === 'win32'
      ? `\\\\.\\pipe\\wrenyard-relay-${process.pid}-${relaySequence}`
      : join(dirname(ipcPath), `wrenyard-relay-${process.pid}-${relaySequence}.sock`);
  };

  /** Public remote install matrix: macOS ARM64, Windows x64 and Linux x64. */
  const supportedTriplet = (platform: string | null, arch: string | null): 'darwin-arm64' | 'win32-x64' | 'linux-x64' | null => {
    if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
    if (platform === 'win32' && arch === 'x64') return 'win32-x64';
    if (platform === 'linux' && arch === 'x64') return 'linux-x64';
    return null;
  };

  const unsupportedPlatformMessage = (platform: string | null, arch: string | null): string =>
    `不支持的目标平台（${platform ?? '未知'}-${arch ?? '未知'}）；仅支持 macOS ARM64、Windows x64 与 Linux x64`;

  /** Bounded projection of a renderer-supplied candidate into typed fields. */
  const normalizeRemoteInput = (value: unknown): RemoteConnectionTestInput => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { alias: '' };
    const record = value as Record<string, unknown>;
    return {
      alias: typeof record.alias === 'string' ? record.alias : '',
      ...(typeof record.host === 'string' ? { host: record.host } : {}),
      ...(typeof record.user === 'string' ? { user: record.user } : {}),
      ...(typeof record.port === 'number' ? { port: record.port } : {}),
      ...(typeof record.identityPath === 'string' ? { identityPath: record.identityPath } : {}),
      ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
    };
  };

  /**
   * Project saved daemon-config records into the shared host view. The daemon
   * stores only alias/display name and verified platform metadata, so the
   * address stays honestly unknown (null) rather than being fabricated.
   */
  const toSavedHostViews = (hosts: unknown): RemoteHostView[] => {
    if (!Array.isArray(hosts)) return [];
    const views: RemoteHostView[] = [];
    for (const entry of hosts) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.alias !== 'string' || record.alias === '') continue;
      views.push({
        alias: record.alias,
        displayName: typeof record.displayName === 'string' && record.displayName !== '' ? record.displayName : record.alias,
        address: null,
        os: typeof record.platform === 'string' && record.platform !== '' ? record.platform : null,
      });
    }
    return views;
  };

  /**
   * Ephemeral silent/Test validation: structural validation of the candidate,
   * then a non-installing remote probe under `ssh -F` with the candidate in a
   * private temp config. It never writes the user's SSH config and never
   * installs anything.
   */
  const validateRemoteCandidate = async (
    input: RemoteConnectionTestInput,
  ): Promise<RemoteConnectionTestResult> => {
    const validated = validateSshCandidate(input);
    if (!validated.ok) return { ok: false, message: validated.message };
    const candidate = validated.candidate;
    const hasExplicitFields = candidate.host !== null || candidate.user !== null
      || candidate.port !== null || candidate.identityPath !== null;
    try {
      const probe = hasExplicitFields
        ? await withCandidateConfig(candidate, sshConfigPath, (configFile) => probeSshHost(candidate.alias, { configFile }))
        : await probeSshHost(candidate.alias);
      if (!supportedTriplet(probe.platform, probe.arch)) {
        return {
          ok: false,
          platform: probe.platform,
          arch: probe.arch,
          message: probe.platform === null && probe.arch === null
            ? '无法连接或未识别远程系统（请确认主机密钥已手动信任且可免密登录）'
            : unsupportedPlatformMessage(probe.platform, probe.arch),
        };
      }
      return { ok: true, platform: probe.platform, arch: probe.arch };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  };

  /**
   * Validate, provision if needed, connect and remember a remote host.
   *
   * The *entire* sequence — authoritative idle check, readiness, the SSH
   * configuration write and the context switch — runs inside the connection
   * context's transition lock. The lock and the reserved generation are taken
   * synchronously before the first await, so a second switch can never
   * interleave and every business request is denied for the whole `connecting`
   * window. The active endpoint target is only retargeted once the switch
   * commits, so the target stays hidden until the SSH configuration is
   * persisted.
   *
   * The authoritative idle refusal happens before anything is provisioned or
   * persisted, so it leaves no trace. Every ssh invocation (probe, bootstrap
   * transfer, remote command, relay verification) runs under the ephemeral `-F`
   * candidate so a not-yet-persisted add-new host resolves exactly the stanza
   * that will be appended.
   *
   * The host is remembered in the daemon config *before* the context commits,
   * while the state is still `connecting`, so no business request ever reaches
   * the candidate endpoint and no view is retargeted before the registry record
   * is saved. Because the commit that follows is a non-failing assignment, a
   * failure at any earlier step aborts with nothing active and no new record;
   * the appended `Host` stanza is still rewound to its exact previous bytes
   * (without clobbering a concurrent edit). Only a relay this app started is
   * stopped, and an SSH rollback conflict is surfaced rather than swallowed.
   */
  const activateRemoteConnection = async (input: RemoteConnectionTestInput): Promise<void> => {
    const validated = validateSshCandidate(input);
    if (!validated.ok) throw new Error(validated.message);
    const candidate = validated.candidate;
    const displayName = typeof input.displayName === 'string' && input.displayName.trim() !== ''
      ? input.displayName.trim()
      : undefined;
    const hostName = displayName ?? candidate.alias;
    const hasExplicitFields = candidate.host !== null || candidate.user !== null
      || candidate.port !== null || candidate.identityPath !== null;
    const previousRelay = activeSshRelay;
    // Captured before the lock: only a reachable endpoint has work the
    // pre-switch idle check could protect. A stopped local daemon or a lost
    // remote tunnel must not make a new connection impossible.
    const leavingContextSettled = canConnectDaemon();

    // An add-new candidate lives in a private temp config for the whole
    // transaction; an already-configured alias uses the user's default config.
    const withSshConfig = <T>(use: (configFile: string | null) => Promise<T>): Promise<T> =>
      hasExplicitFields
        ? withCandidateConfig(candidate, sshConfigPath, (configFile) => use(configFile))
        : use(null);

    let stanzaRollback: SshStanzaRollback | null = null;
    let verifiedPlatform: string | null = null;
    let verifiedArch: string | null = null;
    // Held on an object so the assignment made inside the connect callback is
    // visible to the rollback path below; a plain `let` would be narrowed to its
    // initial `null` because the closure assignment is invisible to flow analysis.
    const transaction: { relay: SshRelay | null } = { relay: null };

    /** Rewind the appended `Host` stanza; report a conflict instead of hiding it. */
    const rollbackSshConfig = async (): Promise<unknown> => {
      const rollback = stanzaRollback;
      stanzaRollback = null;
      if (rollback === null) return null;
      try {
        await restoreSshHostStanza(rollback);
        return null;
      } catch (error) {
        return error;
      }
    };

    try {
      await connectionContext!.connectToRemote(
        { alias: candidate.alias, displayName: hostName },
        async (generation) => {
          connectionContext!.assertCurrent(generation);
          return withSshConfig(async (configFile) => {
            // ── 0. Authoritative pre-switch idle check ───────────────────────
            // Read daemon.status from the endpoint being left (the bridge is not
            // retargeted yet); it is not a business request, so it is allowed
            // while the state is already `connecting`. Nothing has been
            // provisioned or persisted, so a refusal leaves no trace.
            await assertActiveContextIdle(leavingContextSettled);
            connectionContext!.assertCurrent(generation);

            // ── 1. Readiness ────────────────────────────────────────────────
            // Probe (installs nothing, writes no config), provision the
            // versioned payload and verify the remote daemon's protocol/version
            // handshake.
            const probeOptions = configFile ? { configFile } : {};
            const probe = await probeSshHost(candidate.alias, probeOptions);
            connectionContext!.assertCurrent(generation);
            const triplet = supportedTriplet(probe.platform, probe.arch);
            if (!triplet) {
              if (probe.platform === null && probe.arch === null) {
                throw new Error('无法连接或未识别远程系统（请确认主机密钥已手动信任且可免密登录）');
              }
              throw new Error(unsupportedPlatformMessage(probe.platform, probe.arch));
            }
            const platform = probe.platform as RemotePlatform;
            const arch = probe.arch as string;
            verifiedPlatform = platform;
            verifiedArch = arch;

            const bootstrap = await bootstrapRemoteDaemon({
              target: { alias: candidate.alias, platform, arch },
              version,
              ...(configFile ? { candidateConfigFile: configFile } : {}),
            });
            connectionContext!.assertCurrent(generation);

            const relay = new SshRelay({
              target: { alias: candidate.alias, platform, arch },
              remote: {
                nodePath: bootstrap.nodePath,
                bridgePath: bootstrap.bridgePath,
                ipcPath: bootstrap.ipcPath,
                bridgeArgs: bootstrap.bridgeArgs,
              },
              localEndpointPath: nextRelayEndpointPath(),
              expectedVersion: version,
              ...(configFile ? { candidateConfigFile: configFile } : {}),
              onTunnelLost: (reason: string) => {
                // Only the committed relay may change the context: a candidate
                // whose tunnel drops during the switch must not mark the
                // *previous* active remote lost.
                if (activeSshRelay !== relay) return;
                // Explicit disconnected-remote; never a silent local fallback.
                void connectionContext?.markDisconnected(`远程连接已断开：${reason}`);
              },
            });
            transaction.relay = relay;
            await relay.start();

            // ── 2. Persistence: the SSH configuration ───────────────────────
            // Append the nonconflicting `Host` stanza. Its exact previous bytes
            // are rewound if the transaction fails, so the SSH config is never
            // left half-applied.
            if (hasExplicitFields) {
              const appended = await appendSshHostStanza(candidate, { configPath: sshConfigPath });
              if (!appended.ok) throw new Error(appended.message);
              stanzaRollback = appended.rollback;
            }
            // The stanza is now in the user's config, so the default config
            // resolves the new host: the relay can drop its `-F` candidate.
            relay.commitSshConfig();

            // ── 3. Persistence: remember the host in the daemon's own config ─
            // The host is remembered *before* the context commits, while the
            // state is still `connecting`: no business request reaches the
            // candidate endpoint and no view is retargeted until the registry
            // record is saved, so a failed save aborts with nothing active and
            // leaves no stale record behind.
            await requestLocalDaemon('remote.host.save', {
              alias: candidate.alias,
              displayName: hostName,
              platform: verifiedPlatform,
              arch: verifiedArch,
              daemonVersion: version,
              ready: true,
            });

            // ── 4. Commit the switch (only now is the target visible) ───────
            // Everything past this point is a non-failing assignment, so the
            // commit cannot leave a remembered host without an active context.
            activeSshRelay = relay;
            return {
              endpoint: relay.endpoint,
              host: { alias: candidate.alias, displayName: hostName, platform, arch },
            };
          });
        },
      );
    } catch (error) {
      // Detach the candidate first: its tunnel-loss callback must not be
      // attributed to it while the previous context is being restored.
      const failedRelay = transaction.relay;
      transaction.relay = null;
      activeSshRelay = previousRelay;
      const rollbackError = await rollbackSshConfig();
      if (failedRelay) await failedRelay.stop().catch(() => undefined);
      throw withSshRollbackNote(error, rollbackError);
    }
    // Only a previous relay this app owned is stopped; an externally owned
    // remote daemon is never stopped.
    if (previousRelay && previousRelay !== transaction.relay) await previousRelay.stop();
  };

  // The renderer bridge (typed in the shell contract). Every value is
  // re-validated at this boundary; saved hosts are read/written through the
  // local daemon and are never a Desktop settings source of truth.
  ipcMain.handle(SHELL_CHANNELS.remoteState, (): RemoteConnectionSnapshot => connectionContext!.snapshot());
  ipcMain.handle(SHELL_CHANNELS.remoteHostList, async (): Promise<RemoteHostListResult> => {
    const result = await requestLocalDaemon('remote.host.list', {}) as { hosts?: unknown };
    return { hosts: toSavedHostViews(result?.hosts) };
  });
  ipcMain.handle(SHELL_CHANNELS.remoteHostDiscovered, async (): Promise<RemoteHostListResult> => {
    const hosts = await listLocalSshHosts({ configPath: sshConfigPath });
    return {
      hosts: hosts.map((host) => ({
        alias: host.alias,
        displayName: host.displayName,
        address: host.address,
        os: host.os,
      })),
    };
  });
  ipcMain.handle(
    SHELL_CHANNELS.remoteHostTest,
    async (_event, input: unknown): Promise<RemoteConnectionTestResult> =>
      validateRemoteCandidate(normalizeRemoteInput(input)),
  );
  ipcMain.handle(SHELL_CHANNELS.remoteHostConfirm, async (_event, input: unknown): Promise<RemoteHostMutationResult> => {
    try {
      await activateRemoteConnection(normalizeRemoteInput(input));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  });
  ipcMain.handle(SHELL_CHANNELS.remoteHostConnect, async (_event, alias: unknown): Promise<RemoteHostMutationResult> => {
    try {
      const validated = validateSshAlias(alias);
      if (!validated.ok) return { ok: false, message: validated.message };
      await activateRemoteConnection({ alias: validated.alias });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  });
  ipcMain.handle(SHELL_CHANNELS.remoteHostRename, async (_event, alias: unknown, displayName: unknown): Promise<RemoteHostMutationResult> => {
    try {
      const validated = validateSshAlias(alias);
      if (!validated.ok) return { ok: false, message: validated.message };
      const name = typeof displayName === 'string' ? displayName.trim() : '';
      if (name === '') return { ok: false, message: '请输入显示名称' };
      await requestLocalDaemon('remote.host.rename', { alias: validated.alias, displayName: name });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  });
  ipcMain.handle(SHELL_CHANNELS.remoteReturnLocal, async (): Promise<RemoteHostMutationResult> => {
    try {
      if (connectionContext!.snapshot().state === 'local') return { ok: true };
      await connectionContext!.returnToLocal();
      const relay = activeSshRelay;
      activeSshRelay = null;
      // Only our relay process is stopped; an externally owned remote daemon is
      // never stopped.
      await relay?.stop();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  });

  const version = app.getVersion();
  const buildTime = resolveDesktopBuildTime();
  const getSettings = async () => buildSettingsSnapshot({
    endpoint: activeEndpointPath,
    workspace: workspaceConfiguration!,
    desktopVersion: version,
    wrenyardVersion: version,
    buildTime,
    readHealth: () => canConnectDaemon() ? readWrenyardHealth(activeEndpointPath) : Promise.resolve({ connected: false }),
    readGatewayModels: async () => { requireDaemonRunning(); return readGatewayConnection(activeEndpointPath).then((connection) => connection.models); },
    readPet: async () => petController!.snapshot(),
    readUpdate: () => updateController!.snapshot(),
  });
  // Daemon lifecycle surface: read the live projection, or start/restart the
  // daemon when this Desktop supervises it.
  ipcMain.handle(SHELL_CHANNELS.daemonSnapshot, () => daemonSnapshot());
  ipcMain.handle(SHELL_CHANNELS.daemonStart, async () => {
    if (quitController?.isQuitting()) return daemonSnapshot();
    // While remote, daemon lifecycle actions must not target the local
    // supervisor: the active daemon is externally owned and never restarted.
    if (isNonLocalContext()) throw new Error('远程模式下无法启动本地 daemon');
    await daemonSupervisor?.start();
    return daemonSnapshot();
  });
  ipcMain.handle(SHELL_CHANNELS.daemonRestart, async () => {
    if (quitController?.isQuitting()) return daemonSnapshot();
    if (isNonLocalContext()) throw new Error('远程模式下无法重启本地 daemon');
    if (daemonSupervisor?.mode === 'supervised') await daemonSupervisor.restart();
    else await daemonSupervisor?.start();
    return daemonSnapshot();
  });

  // Mini cards: the shell opens a frameless card (hiding itself); a card opens
  // another card (offset from itself) or returns to the shell. Only trusted
  // shell surfaces may drive these; every other sender is a no-op.
  ipcMain.handle(SHELL_CHANNELS.openMiniCard, (event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid session id');
    if (!isTrustedShellSender(event.sender)) return;
    miniCards?.openCard(sessionId, event.sender);
  });
  ipcMain.handle(SHELL_CHANNELS.restoreMain, (event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid session id');
    if (!miniCards?.isCardSender(event.sender)) return;
    miniCards.restoreMain(event.sender, sessionId);
  });
  // 置顶 and 关闭 are card-scoped: they act on the sender card only.
  ipcMain.handle(SHELL_CHANNELS.alwaysOnTop, (event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid always-on-top flag');
    if (!miniCards?.isCardSender(event.sender)) return;
    miniCards.setAlwaysOnTop(event.sender, enabled);
  });
  ipcMain.handle(SHELL_CHANNELS.closeWindow, (event) => {
    if (!miniCards?.isCardSender(event.sender)) return;
    miniCards.closeCard(event.sender);
  });

  // `general.startupPage` controls the first page: 'session' always, or 'last'
  // restores the page the shell was on when it last ran. Explicit second-instance
  // navigation (`--settings`) still overrides it below.
  const initialShellPage: ShellPage = settingsStore.load().general.startupPage === 'session'
    ? 'session'
    : loadedSettings?.window.lastPage ?? 'session';

  shellWindow = await ShellWindowController.create({
    pageLoader,
    preloadPath: preloadPath(app.getAppPath(), 'shell'),
    appVersion: version,
    smoke: SMOKE,
    icon: appearanceController.iconPath('png256') ?? resolveAppIcon(),
    initialAppearance: appearanceController.resolve(),
    backgroundColor: appearanceController.backgroundColor(),
    attachAppearance: (window) => appearanceController?.attach(window),
    titleBarOverlay: appearanceController.titleBarOverlay(),
    additionalArguments: appearanceController.arguments(),
    isTrustedSender: (sender) => isTrustedShellSender(sender),
    initialPage: initialShellPage,
    initialGeometry: loadedSettings?.window.shell,
    initiallyMaximized: loadedSettings?.window.shellMaximized,
    onGeometryChanged: (shell, shellMaximized) => {
      if (SMOKE) return;
      settingsStore.patch('window', { ...settingsStore.load().window, shell, shellMaximized });
    },
    onPageChanged: (page) => {
      if (SMOKE) return;
      const windowSettings = settingsStore.load().window;
      if (windowSettings.lastPage === page) return;
      settingsStore.patch('window', { ...windowSettings, lastPage: page });
    },
    onCreated: (controller) => { shellWindow = controller; },
    getAppearance: () => appearanceController!.resolve(),
    getSettings,
    getStats: () => { requireDaemonRunning(); return readStatsSnapshot(activeEndpointPath); },
    request: (method, params) => daemonClient.request(method, params),
    getQuota: (forceRefresh = false) => quotaController!.getSnapshot(forceRefresh),
    saveProviderOrder: async (providerIds: string[]) => {
      settingsStore.patch('providers', {
        providers: reorderProviders(settingsStore.load().providers.providers, providerIds),
      });
      return quotaController!.notifyConfigurationChanged();
    },
    configureProviderKey: async (providerId: string, key: string) => {
      // The daemon owns the gateway routes and the session backend picks up
      // changed credentials itself. The credential write alone gates success:
      // the forced quota refresh runs in the background so the save is
      // acknowledged immediately, and the returned catalog may stay stale until
      // that refresh notifies. The key is never logged.
      await providerService.configureApiKey(providerId, key);
      void quotaController!.getSnapshot(true).catch((error: unknown) => {
        console.warn(
          '[wrenyard-desktop] quota refresh after provider key update failed:',
          error instanceof Error ? error.message : String(error),
        );
      });
      return quotaController!.snapshot();
    },
    getUpdate: async () => updateController!.snapshot(),
    checkUpdate: () => updateController!.checkForUpdates(),
    requestInstall: () => updateController!.requestInstall(),
    getOperationComponents: () => getOperationComponents(),
    runOperationComponentAction: (id: OperationComponentId, action: OperationComponentAction) => (
      runOperationComponentAction(id, action)
    ),
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
      if (quitController?.isQuitting()) throw new Error('正在退出，无法切换工作区');
      requireDaemonRunning();
      // Initializing a workspace is remote-safe when remote: the daemon creates
      // the directory on its own host, so the local machine never stats or
      // creates a remote path. Locally the same onboarding runs in Desktop; in
      // both cases the daemon owns the authoritative workspace.root write.
      let root: string;
      if (create && isNonLocalContext()) {
        const initialized = await requestForeman('workspace.initialize', { root: path.trim() }) as DaemonWorkspaceInitializeResult;
        if (!initialized.ok) throw new Error(initialized.message ?? '初始化远程工作区失败');
        root = initialized.root ?? path.trim();
      } else if (create) {
        root = await initializeProductWorkspace(path);
      } else {
        root = path.trim();
      }
      if (root === '') throw new Error('请输入 workspace 路径');
      // The daemon applies the change in place: it rebinds every workspace-scoped
      // service and persists the root while the same process, lock, database and
      // IPC endpoint stay alive. A busy or shutting-down daemon refuses with an
      // actionable reason instead of the old config-then-restart dance.
      const result = await requestForeman('workspace.switch', { root }) as DaemonWorkspaceSwitchResult;
      if (result.ok !== true) {
        throw new Error(result.message ?? '切换工作区失败，请重试。');
      }
      // Re-read the active workspace (remote-safe while remote), then rebuild the
      // Desktop session surface so the previous workspace's session ids cannot
      // silently carry over. Retire the old live polls first.
      sessionRegistration?.reset();
      const refreshed = await readActiveWorkspaceSnapshot();
      workspaceConfiguration = refreshed;
      desktopSubscriptions?.reconnect();
      notifyDaemonChanged();
      shellWindow?.deliverCommandAction({ id: 'session.newDraft' });
      return refreshed;
    },
    // Task detail/transcript windows are general Desktop windows, owned by the
    // window owner and reachable even when Pet is hidden.
    openTaskTranscript: (taskRunId, title) => windowOwner.openTaskTranscript(taskRunId, title),
    openTaskGraph: (taskGraphId) => windowOwner.openTaskGraph(taskGraphId),
    getTaskSettings: (project?: string, taskId?: string) => getTaskSettings(project, taskId),
    saveTaskSettings: (request: TaskSettingsSaveRequest) => saveTaskSettings(request),
    runtimeAliasSnapshot: () => getRuntimeAliasSnapshot(),
    runtimeAliasPut: (request: RuntimeAliasPutRequest) => putRuntimeAlias(request),
    runtimeAliasRemove: (request: RuntimeAliasRemoveRequest) => removeRuntimeAlias(request),
    requestTaskRoutingTest: (params: TaskRoutingTestParams) => requestTaskRoutingTest(params),
    requestRoutingTestTasks: () => requestRoutingTestTasks(),
    requestBot: (method: BotMethod, params?: unknown) => requestBot(method, params),
    requestAgent: (method: AgentMethod, params?: unknown) => requestAgent(method, params),
    execStart: (request: ExecStartRequest) => execStart(request),
    execGet: (id: string) => execGet(id),
    execEvents: (request: ExecEventsRequest) => execEvents(request),
    execCancel: (id: string) => execCancel(id),
    getNotificationSnapshot: () => inAppChannel.snapshot(),
    dismissNotification: (id: string) => inAppChannel.remove(id),
    clearNotifications: () => inAppChannel.clear(),
    markNotificationsRead: () => inAppChannel.markAllRead(),
    getPreferences: async () => preferencesController!.get(),
    setPreference: async (id: PreferenceId, value: unknown) => preferencesController!.set(id, value),
    getActivityStatus: () => activityProjector.get(),
    // Local-only bypasses are explicitly unavailable while remote: they must
    // never open a same-named local path for remote data.
    openSettingsFile: async () => {
      if (isNonLocalContext()) throw new Error('远程模式下无法打开本地设置文件');
      await shell.openPath(settingsPath);
    },
    openLogsDirectory: async () => {
      if (isNonLocalContext()) throw new Error('远程模式下无法打开本地日志目录');
      await shell.openPath(join(foremanStateRoot(), 'logs'));
    },
    revealWorkspace: async (path: string) => {
      if (isNonLocalContext()) throw new Error('远程模式下无法在本地打开远程路径');
      shell.showItemInFolder(path);
    },
  });
  interfaceZoom.applyShellZoom();
  // Keep any already-open cards on the same zoom as the shell at startup.
  miniCards?.applyZoomToCards(appearanceController?.zoomFactor() ?? 1);
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
      // Windows/Linux have no Cmd+Q confirmation: an accelerator press only
      // backgrounds the app (the same effect as closing the window to the tray)
      // and never arms the macOS gate or quits.
      if (process.platform !== 'darwin') {
        const window = shellWindow?.window;
        if (window && !window.isDestroyed()) window.hide();
        return;
      }
      if (macQuitGate('accelerator') === 'quit') {
        // The second press fully exits; drop any hint still on screen first.
        dismissQuitHint();
        app.quit();
        return;
      }
      // Warn, never quit: a second Cmd+Q inside the 3s window fully exits
      // while Cmd+W only backgrounds. The hint is a small, non-interactive,
      // themed card that dismisses itself; a first press never starts a quit,
      // so make sure nothing stays blocked.
      restoreQuitSurfaces();
      showQuitHint();
    },
    {
      // The View menu drives the same persisted `appearance.zoom` as the setting.
      zoomIn: () => interfaceZoom.setInterfaceZoom((appearanceController?.getSettings().zoom ?? 100) + APPEARANCE_ZOOM_STEP),
      zoomOut: () => interfaceZoom.setInterfaceZoom((appearanceController?.getSettings().zoom ?? 100) - APPEARANCE_ZOOM_STEP),
      reset: () => interfaceZoom.setInterfaceZoom(100),
    },
  )));
  // `update.autoCheck` gates the background schedule; a manual check always works.
  if (!SMOKE && app.isPackaged && settingsStore.load().update.autoCheck) updateController.start();

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
    showQuota: () => settingsStore.load().tray.showQuota ?? true,
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
  // Themed windows register themselves through `attach`; transparent Pet
  // overlays are created by the overlay factory and never receive a theme
  // background. Appearance is deliberately not applied per-window here.
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
      await activeSshRelay?.stop();
      activeSshRelay = null;
      await activeEndpointBridge?.stop();
      activeEndpointBridge = null;
    } catch {
      // best-effort termination
    }
    app.exit(1);
  });
}
