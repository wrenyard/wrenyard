import { app, dialog, Menu, screen, session, type MessageBoxOptions } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WrenyardIpcClient, resolveWrenyardIpcPath, WrenyardRpcError, type WrenyardGatewayConnection } from '@wrenyard/control-client';
import { DesktopPetRuntime, QuotaService } from '@wrenyard/pet/runtime';
import { startDshWeb } from './dsh-process.js';
import { DshConversationClient } from './dsh-conversation-client.js';
import {
  DesktopConversationController,
  type ConfiguredWorkspace,
  type DesktopConversationSession,
} from './conversation-controller.js';
import { sameGatewayIdentity } from './service-recovery.js';
import { defaultMcpUrl, WRENYARD_DSH_PROVIDER_ID, WRENYARD_GATEWAY_TOKEN_ENV, writeModelPatch } from './model-patch.js';
import { prepareProfile } from './profile.js';
import { SummaryModelPreferenceStore, createConversationSummaryService, type ConversationSummaryInput } from './conversation-summary.js';
import { createDesktopTray, type DesktopTrayHandle } from './desktop-tray.js';
import { ensureDesktopActivationPolicy } from './desktop-activation-policy.js';
import { DesktopPetController } from './pet-controller.js';
import { DesktopPetSettingsStore } from './pet-settings-store.js';
import { DesktopQuotaController } from './quota-controller.js';
import { ProviderService } from './provider-service.js';
import { readConversationActivity } from './conversation-activity.js';
import { ClientConfigurationDesktopService } from './client-configuration/service.js';
import { buildSettingsSnapshot, buildSummarySettingsSnapshot, type HealthSnapshot } from './settings-snapshot.js';
import { readStatsSnapshot } from './stats-snapshot.js';
import { isSettingsLaunchRequest, type PetCompanionSettings, type RuntimeAliasPutRequest, type RuntimeAliasRemoveRequest, type RuntimeAliasSnapshot, type ShellPage, type SummarySettingsSnapshot, type TaskRoutingTestParams, type TaskRoutingTestResult, type TaskRoutingTestTasksResult, type TaskSettingsSaveRequest, type TaskSettingsSnapshot } from './shell-contract.js';
import { ShellWindowController } from './shell-window.js';
import { activeTaskCountFromDaemonStatus, DesktopUpdateController } from './update-controller.js';
import { resolveInstallation } from './installation-discovery.js';
import { resolveDesktopBuildTime } from './build-metadata.js';
import { desktopMenuTemplate } from './app-menu.js';
import {
  createMacQuitConfirmationGate,
  trayPrimaryClickOpensDesktop,
  type QuitOrigin,
} from './desktop-interaction-policy.js';
import {
  createProductWorkspace,
  ensureProductWorkspaceRegistered,
  inspectProductWorkspace,
  saveProductWorkspace,
} from './workspace.js';
import { assertDaemonIdle, runPlannedDaemonRestart } from './workspace-activation.js';

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
const SERVICE_RETRY_ATTEMPTS = 10;
const SERVICE_RETRY_DELAY_MS = 500;
/** Smoke drives task enumeration and a routing test over IPC, which can cold-load the workspace and model catalog. */
const SMOKE_TIMEOUT_MS = 90_000;

const require = createRequire(import.meta.url);

function resolveDshBin(): string {
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
  } catch {
    return require.resolve('@deepseek-ai/dsh');
  }
}

function resolveDshVersion(): string {
  try {
    const manifest = require('@deepseek-ai/dsh/package.json') as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveShellSource(): string {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'dsh-shell');
    if (existsSync(packaged)) return packaged;
    throw new Error('Packaged dsh-shell resources missing (extraResources not copied).');
  }
  const dev = resolve(app.getAppPath(), '..', '..', 'packages', 'dsh-shell');
  if (existsSync(dev)) return dev;
  throw new Error('dsh-shell source not found (expected monorepo packages/dsh-shell).');
}

/**
 * Locate the installed Wrenyard suite: an explicit WRENYARD_CLI, the current
 * working directory, or the default prefix. LaunchServices provides no shell
 * profile, so the CLI is located explicitly instead of relying on an inherited
 * PATH.
 */
function resolveWrenyardCli(): string | undefined {
  return resolveInstallation().cliPath;
}

function installedDesktopPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Wrenyard Desktop');
  }
  return join(homedir(), 'Applications', '啾啾工坊.app');
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
      return { connected: true, ...(uptimeMs !== undefined ? { uptimeMs } : {}) };
    }
    return { connected: true };
  } catch {
    return { connected: false };
  } finally {
    await client?.close?.();
  }
}

/** True when health.ping succeeds on the given IPC socket. */
async function probeWrenyard(path: string): Promise<boolean> {
  return (await readWrenyardHealth(path)).connected;
}

async function readGatewayConnection(path: string): Promise<WrenyardGatewayConnection> {
  const client = new WrenyardIpcClient({ path, requestTimeoutMs: FOREMAN_HEALTH_TIMEOUT_MS });
  try { return await client.gatewayConnection(); } finally { client.close(); }
}

/** Start the Wrenyard daemon service once, detached from the app process. */
function startWrenyardService(cli: string): void {
  const child = spawn(cli, ['daemon', 'start'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.unref();
}

async function assertForemanHealthy(): Promise<void> {
  const ipcPath = resolveWrenyardIpcPath();
  if (await probeWrenyard(ipcPath)) return;

  const cli = resolveWrenyardCli();
  if (!cli) {
    throw new Error(
      `Wrenyard is unavailable: health.ping failed on ${ipcPath} and no Wrenyard CLI was found in WRENYARD_CLI, the working directory, or ~/.local/bin`,
    );
  }
  console.error(`[wrenyard-desktop] Wrenyard IPC not ready on ${ipcPath}; starting the Wrenyard service once via ${cli}`);
  startWrenyardService(cli);

  for (let attempt = 1; attempt <= SERVICE_RETRY_ATTEMPTS; attempt += 1) {
    if (await probeWrenyard(ipcPath)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, SERVICE_RETRY_DELAY_MS));
  }
  throw new Error(
    `Wrenyard is unavailable: service did not answer health.ping on ${ipcPath} after ${SERVICE_RETRY_ATTEMPTS * SERVICE_RETRY_DELAY_MS}ms of starting`,
  );
}

function ensureChineseLocale(dshHome: string): void {
  const settingsPath = join(dshHome, 'settings.yaml');
  let existing = '';
  if (existsSync(settingsPath)) existing = readFileSync(settingsPath, 'utf8');
  if (/(?:^|\n)locale\s*:/.test(existing)) return;
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  writeFileSync(settingsPath, `${prefix}locale:\n  preference: zh\n`);
}

function resolveAppIcon(): string | undefined {
  const packaged = join(process.resourcesPath, 'icon.png');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  const fromApp = join(app.getAppPath(), 'resources', 'icon.png');
  return existsSync(fromApp) ? fromApp : undefined;
}

function resolvePetAssets(): { rendererDir: string; preloadDir: string } {
  const root = join(app.getAppPath(), 'dist', 'pet');
  return {
    rendererDir: join(root, 'renderer'),
    preloadDir: join(root, 'preloads'),
  };
}

/** LaunchServices has no shell PATH; resolve quota against the installed suite. */
function resolveQuotaRuntimeBin(): string | undefined {
  const binaryName = process.platform === 'win32' ? 'forge.exe' : 'forge';
  const candidates = [
    process.env.WRENYARD_RUNTIME_BIN,
    process.env.WRENYARD_FORGE_BIN,
    join(homedir(), '.local', 'share', 'wrenyard', 'current', 'bin', binaryName),
    app.isPackaged ? undefined : resolve(app.getAppPath(), '..', '..', 'runtime', 'forge', 'bin', binaryName),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

async function runSmoke(shell: ShellWindowController): Promise<void> {
  const check = async (): Promise<void> => {
    const [shellOk, snapshotOk, conversationOk, quotaOk] = await Promise.all([
      shell.window.webContents.executeJavaScript(
        "document.body?.innerText.includes('啾啾工坊设置') === true",
      ),
      shell.window.webContents.executeJavaScript(
        "window.wrenyardShell.getSettings().then((value) => value?.service?.status === 'connected' && value?.pet?.settings?.entities && Array.isArray(value?.pet?.settings?.quota?.providers) && (value?.update?.channel === 'dev' || value?.update?.channel === 'stable')).catch(() => false)",
      ),
      shell.window.webContents.executeJavaScript(
        "window.wrenyardShell.getConversation().then((value) => value?.status === 'ready' && Array.isArray(value?.sessions) && value?.models?.status === 'ready' && value?.models?.routable === true && value.models.groups.length > 0).catch(() => false)",
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
    // New conversation is an in-memory draft; only the first send persists a
    // session. Repeated create calls must leave the durable list unchanged.
    const newConversationOk = await shell.window.webContents.executeJavaScript(
      "(async () => { const before = await window.wrenyardShell.getConversation(); await window.wrenyardShell.createConversation(); const value = await window.wrenyardShell.createConversation(); return value.status === 'ready' && value.selectedSessionId === undefined && value.selectedRunning === false && value.items.length === 0 && JSON.stringify(value.sessions.map(session => session.id).sort()) === JSON.stringify(before.sessions.map(session => session.id).sort()); })()",
    );
    shell.setPage('settings', false);
    const settingsVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'settings' && document.getElementById('update-action-button') instanceof HTMLButtonElement",
    );
    shell.setPage('stats', false);
    const statsVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'stats' && window.wrenyardShell.getStats().then((value) => value?.status === 'available' || value?.status === 'unavailable').catch(() => false)",
    );
    shell.setPage('quota', false);
    const quotaVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'quota' && document.getElementById('quota-provider-grid') !== null",
    );
    // Routing tab real DOM: the button label must stay on a single line and
    // never clip at constrained toolbar widths, and the stats surfaces must
    // render. Ledger rows are not required because smoke may have no history.
    const routingLayoutOk = await shell.window.webContents.executeJavaScript(
      `(async () => {
        document.getElementById('quota-tab-routing')?.click();
        const button = document.getElementById('routing-test-run');
        const toolbar = document.querySelector('.routing-test-toolbar');
        if (!(button instanceof HTMLElement) || !(toolbar instanceof HTMLElement) || button.innerText.trim() !== '测试') return false;
        const statsOk = document.getElementById('stats-task-runs-list') !== null
          && document.body.textContent.includes('近期任务消耗');
        const savedCss = toolbar.style.cssText;
        let layoutOk = true;
        try {
          for (const width of ['140px', '320px']) {
            toolbar.style.width = width;
            toolbar.style.maxWidth = width;
            const rects = Array.from((() => {
              const range = document.createRange();
              range.selectNodeContents(button);
              return range.getClientRects();
            })());
            const textRects = rects.filter((rect) => rect.width > 0 && rect.height > 0);
            if (textRects.length === 0) { layoutOk = false; break; }
            const tops = new Set(textRects.map((rect) => Math.round(rect.top)));
            if (tops.size !== 1) { layoutOk = false; break; }
            if (button.scrollWidth > button.clientWidth) { layoutOk = false; break; }
            if (button.getBoundingClientRect().width <= 0) { layoutOk = false; break; }
          }
        } finally {
          toolbar.style.cssText = savedCss;
        }
        return layoutOk && statsOk;
      })()`,
    );
    if (!routingLayoutOk) {
      throw new Error('smoke failed: routing test button wraps or clips');
    }
    shell.setPage('clients', false);
    const clientsVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'clients' && window.wrenyardShell.getClientConfiguration().then((value) => Array.isArray(value?.surfaces) && Array.isArray(value?.configurations) && Array.isArray(value?.models)).catch(() => false)",
    );
    shell.setPage('workbench', false);
    const workbenchVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'workbench' && document.getElementById('conversation-composer') !== null && (() => { const host = document.getElementById('conversation-model-picker'); return host !== null && host.querySelector('button.multi-select-trigger') instanceof HTMLButtonElement && host.querySelector('[role=\"listbox\"]') !== null; })()",
    );
    if (!shellOk || !snapshotOk || !conversationOk || !quotaOk || !tasksOk || !routingOk || !newConversationOk || !settingsVisible || !statsVisible || !quotaVisible || !clientsVisible || !workbenchVisible) {
      throw new Error(
        `smoke failed (shell=${shellOk}, snapshot=${snapshotOk}, conversation=${conversationOk}, quota=${quotaOk}, tasks=${tasksOk}, routing=${routingOk}, newConversation=${newConversationOk}, settings=${settingsVisible}, stats=${statsVisible}, quotaPage=${quotaVisible}, clients=${clientsVisible}, workbench=${workbenchVisible})`,
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

/** Smoke-only probe: whether the DSH backend child process is still live. */
function isDshChildAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Smoke-only lifecycle observability (never exposed to renderer IPC): exercise
 * the production close-to-background and tray-restore paths and verify they
 * preserve the exact same live DSH backend child.
 */
async function runSmokeWindowLifecycle(shell: ShellWindowController): Promise<void> {
  const originalPid = conversationController?.backendProcessId;
  if (!originalPid) {
    throw new Error('smoke failed: active conversation session has no DSH backend pid');
  }
  const window = shell.window;
  window.show();
  window.focus();
  window.close();
  if (window.isDestroyed() || window.isVisible()) {
    throw new Error('smoke failed: close did not hide the shell window to the tray');
  }
  if (!isDshChildAlive(originalPid) || conversationController?.backendProcessId !== originalPid) {
    throw new Error('smoke failed: DSH backend pid changed or exited after hide');
  }
  if (!desktopTray) {
    throw new Error('smoke failed: tray is unavailable for the restore check');
  }
  if (trayPrimaryClickOpensDesktop(process.platform)) {
    desktopTray.tray.emit('click');
    if (window.isDestroyed() || !window.isVisible()) {
      throw new Error('smoke failed: tray primary click did not restore the shell window');
    }
  } else {
    // macOS primary click only opens the tray menu; its explicit 打开 item is
    // bound to this same shared showDesktop path, which is the restore gesture
    // to verify here without assuming a click restores.
    showDesktop('workbench');
    if (window.isDestroyed() || !window.isVisible()) {
      throw new Error('smoke failed: tray menu open did not restore the shell window');
    }
  }
  if (!isDshChildAlive(originalPid) || conversationController?.backendProcessId !== originalPid) {
    throw new Error('smoke failed: DSH backend pid changed or exited after tray restore');
  }
}

/**
 * Owner-only wait for exactly one task run a conversation work turn
 * dispatched. The daemon's own `task.run.wait` blocks until the run reaches a
 * terminal status, so no server timeout is requested and the transport
 * deadline stays disabled — a legitimately long task is never cut short and
 * the model never polls. The wait owns its own connection and closes it on
 * abort and on completion alike, so an abandoned wait leaves no socket behind.
 */
async function waitForTaskRunResult(
  ipcPath: string,
  taskRunId: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error('任务等待已取消');
  const client = new WrenyardIpcClient({ path: ipcPath });
  const onAbort = (): void => client.close();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await client.taskRunWait(taskRunId);
  } finally {
    signal.removeEventListener('abort', onAbort);
    client.close();
  }
}

/** Owner-only cancellation of a task run a conversation work turn still owns. */
async function cancelOwnedTaskRun(ipcPath: string, taskRunId: string): Promise<void> {
  const client = new WrenyardIpcClient({ path: ipcPath, requestTimeoutMs: FOREMAN_HEALTH_TIMEOUT_MS });
  try {
    await client.request('task.run.cancel', { task_run_id: taskRunId });
  } finally {
    await client.close?.();
  }
}

async function createConversationSession(
  workspace: ConfiguredWorkspace,
  ipcPath: string,
  onUnexpectedExit: (message: string) => void,
  summarize: (input: ConversationSummaryInput) => Promise<string>,
): Promise<DesktopConversationSession> {
  const shellSource = resolveShellSource();
  const dshHome = join(app.getPath('userData'), 'dsh');
  const runtimeModules = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : join(app.getAppPath(), 'node_modules');
  const profile = await prepareProfile(dshHome, shellSource, runtimeModules);
  ensureChineseLocale(profile.dshHome);
  const registration = await ensureProductWorkspaceRegistered(profile.dshHome, workspace.path);
  const gateway = await readGatewayConnection(ipcPath);
  lastGatewayConnection = gateway;
  const patchPath = await writeModelPatch(profile.dshHome, gateway);
  const extraEnv: NodeJS.ProcessEnv = { [WRENYARD_GATEWAY_TOKEN_ENV]: gateway.token };
  const configuredProviderIds = [WRENYARD_DSH_PROVIDER_ID];
  const wrenyardEnv: NodeJS.ProcessEnv = {
    WRENYARD_IPC_PATH: ipcPath,
    WRENYARD_MCP_URL: defaultMcpUrl(),
  };
  const sender = process.env.WRENYARD_MCP_SENDER ?? process.env.FOREMAN_MCP_SENDER;
  if (sender) wrenyardEnv.WRENYARD_MCP_SENDER = sender;

  const dsh = await startDshWeb({
    binPath: resolveDshBin(),
    profileHome: profile.dshHome,
    workspace: workspace.path,
    runAsElectron: true,
    wrenyardEnv,
    patchPath,
    extraEnv,
  });
  const client = new DshConversationClient({
    baseUrl: dsh.url,
    workspaceId: registration.id,
    workspace,
    configuredProviderIds,
    statePath: join(app.getPath('userData'), 'workspace-state', `${createHash('sha256').update(workspace.path).digest('hex')}.json`),
    summarize,
    // Nonblocking dispatch: a work turn owns the runs it dispatched and learns
    // their authoritative outcome from the daemon itself, never from the model.
    waitForTaskRun: (taskRunId, signal) => waitForTaskRunResult(ipcPath, taskRunId, signal),
    cancelTaskRun: (taskRunId) => cancelOwnedTaskRun(ipcPath, taskRunId),
    onChanged: () => shellWindow?.notifyConversationChanged(),
  });
  let intentionalStop = false;
  dsh.child.on('exit', (code, signal) => {
    if (intentionalStop || quitting) return;
    client.stop();
    onUnexpectedExit(`DSH 会话后端已停止（code ${code ?? 'unknown'}，signal ${signal ?? 'none'}）`);
  });
  try {
    await client.start();
  } catch (error) {
    intentionalStop = true;
    client.stop();
    await dsh.stop().catch(() => undefined);
    throw error;
  }

  // Internal smoke observability only; never exposed to renderer IPC.
  return {
    backendProcessId: dsh.child.pid,
    snapshot: () => client.snapshot(),
    select: (sessionId) => client.select(sessionId),
    create: () => client.create(),
    selectModel: (provider, model, reasoningEffort) => client.selectModel(provider, model, reasoningEffort),
    send: (text, clientTimeZone) => client.send(text, clientTimeZone),
    cancel: () => client.cancel(),
    stop: async () => {
      intentionalStop = true;
      client.stop();
      await dsh.stop();
    },
  };
}

/** Daemon/DSH recovery interval; conservative and unref'd so it never blocks quit. */
const GATEWAY_RECOVERY_INTERVAL_MS = 2_000;

let recoveryWatcher: ReturnType<typeof setInterval> | null = null;
let recoveryTickRunning = false;
let gatewayDownObserved = false;
/** Last gateway connection read at DSH spawn time, for identity comparison only. */
let lastGatewayConnection: WrenyardGatewayConnection | null = null;
/**
 * A gateway model refresh (provider key configured) whose backend rebuild is
 * deferred because turns were still running. The recovery watcher completes it
 * once no turn is active, so configuring a key never cancels an ongoing message.
 */
let pendingModelRefreshRebuild = false;

/**
 * True while any conversation turn is still executing. Rebuilding the DSH
 * backend under an active turn would cancel it, so this is exactly the state
 * a deferred rebuild waits on.
 */
function conversationHasActiveTurns(): boolean {
  const controller = conversationController;
  if (!controller) return false;
  const snapshot = controller.snapshot();
  if (snapshot.status !== 'ready') return false;
  return snapshot.selectedRunning === true
    || snapshot.sessions.some((session) => session.running)
    || (snapshot.turns?.some((turn) => turn.running) ?? false);
}

/**
 * Refresh the conversation backend after provider credentials changed. The
 * DSH model patch is generated from the gateway connection at spawn time, so
 * new routes only become selectable once the backend is rebuilt with a fresh
 * patch. The rebuild reuses the selection-preserving recovery lifecycle and is
 * deferred while any turn runs; a gateway whose identity did not change needs
 * no rebuild at all. Errors are warned, not thrown: the key itself was saved
 * and the recovery watcher retries a failed session rebuild on its own.
 */
async function refreshConversationBackendAfterProviderChange(ipcPath: string): Promise<void> {
  const controller = conversationController;
  if (!controller || controller.workspace.status !== 'configured' || !controller.workspace.path) return;
  // Mark the refresh pending before any read or recovery is attempted: if the
  // gateway snapshot cannot be read, or the rebuild below fails transiently,
  // the flag must survive so the recovery watcher retries it instead of the
  // new provider route being silently lost for this session.
  pendingModelRefreshRebuild = true;
  let connection: WrenyardGatewayConnection;
  try {
    connection = await readGatewayConnection(ipcPath);
  } catch (error) {
    console.warn('[wrenyard-desktop] gateway connection refresh after provider change failed:', error instanceof Error ? error.message : String(error));
    return;
  }
  // Only a confirmed unchanged gateway identity makes the refresh unnecessary.
  if (lastGatewayConnection !== null && sameGatewayIdentity(lastGatewayConnection, connection)) {
    pendingModelRefreshRebuild = false;
    return;
  }
  if (conversationHasActiveTurns()) return;
  await controller.recover(true)
    .then(() => {
      pendingModelRefreshRebuild = false;
    })
    .catch((error: unknown) => {
      console.warn('[wrenyard-desktop] conversation backend rebuild after provider change failed:', error instanceof Error ? error.message : String(error));
    });
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

/**
 * Bounded daemon/DSH recovery watcher (started after bootstrap). Each healthy
 * probe lets an unexpectedly exited DSH child rebuild; the first down->up
 * transition after an observed daemon outage compares the fresh gateway
 * connection identity against the one used at spawn time and forces a single
 * session rebuild only when the identity changed. Never replays a prompt,
 * draft, task or renderer navigation.
 */
function startGatewayRecoveryWatcher(ipcPath: string): void {
  if (recoveryWatcher) return;
  const watcher = setInterval(() => {
    if (recoveryTickRunning || !conversationController) return;
    recoveryTickRunning = true;
    void runGatewayRecoveryTick(ipcPath).finally(() => {
      recoveryTickRunning = false;
    });
  }, GATEWAY_RECOVERY_INTERVAL_MS);
  (watcher as { unref?: () => void }).unref?.();
  recoveryWatcher = watcher;
}

function stopGatewayRecoveryWatcher(): void {
  if (recoveryWatcher) {
    clearInterval(recoveryWatcher);
    recoveryWatcher = null;
  }
  recoveryTickRunning = false;
  gatewayDownObserved = false;
  pendingModelRefreshRebuild = false;
}

async function runGatewayRecoveryTick(ipcPath: string): Promise<void> {
  const controller = conversationController;
  if (!controller) return;
  const workspaceConfigured = controller.workspace.status === 'configured' && Boolean(controller.workspace.path);
  let healthy = false;
  try {
    healthy = await probeWrenyard(ipcPath);
  } catch {
    healthy = false;
  }
  if (!healthy) {
    gatewayDownObserved = true;
    return;
  }
  if (gatewayDownObserved) {
    await refreshQuotaProjectionAfterGatewayRestart();
    let connection: WrenyardGatewayConnection;
    try {
      connection = await readGatewayConnection(ipcPath);
    } catch {
      // Health may recover just before the daemon publishes its gateway
      // snapshot. Keep the transition pending and retry identity comparison on
      // the next tick instead of treating an unreadable snapshot as unchanged.
      return;
    }
    gatewayDownObserved = false;
    const identityChanged = lastGatewayConnection !== null
      && !sameGatewayIdentity(lastGatewayConnection, connection);
    lastGatewayConnection = connection;
    if (!workspaceConfigured) {
      pendingModelRefreshRebuild = false;
      return;
    }
    // A forced identity rebuild already carries the freshest gateway models,
    // so a deferred provider refresh becomes obsolete the moment it runs —
    // but only once that rebuild actually succeeded.
    await controller.recover(identityChanged)
      .then(() => {
        if (identityChanged) pendingModelRefreshRebuild = false;
      })
      .catch((error: unknown) => {
        console.warn('[wrenyard-desktop] gateway recovery failed:', error instanceof Error ? error.message : String(error));
      });
    return;
  }
  if (!workspaceConfigured) {
    pendingModelRefreshRebuild = false;
    return;
  }
  if (pendingModelRefreshRebuild) {
    // Complete the deferred provider-key rebuild only once every turn settled;
    // while any is still running the rebuild stays deferred, never forced.
    if (conversationHasActiveTurns()) return;
    // The flag is cleared only after a successful rebuild: a transient
    // recovery failure must leave it pending so the next tick retries.
    await controller.recover(true)
      .then(() => {
        pendingModelRefreshRebuild = false;
      })
      .catch((error: unknown) => {
        console.warn('[wrenyard-desktop] deferred provider model refresh failed:', error instanceof Error ? error.message : String(error));
      });
    return;
  }
  await controller.recover(false).catch((error: unknown) => {
    console.warn('[wrenyard-desktop] DSH session recovery failed:', error instanceof Error ? error.message : String(error));
  });
}

let conversationController: DesktopConversationController | null = null;
let shellWindow: ShellWindowController | null = null;
let desktopTray: DesktopTrayHandle | null = null;
let petController: DesktopPetController | null = null;
let quotaController: DesktopQuotaController | null = null;
let updateController: DesktopUpdateController | null = null;
/**
 * Ordinary LLM conversation-summary service (single request to the local
 * Gateway; never the Task/DSH agent runtime). Null until bootstrap wires it.
 */
let conversationSummary: ReturnType<typeof createConversationSummaryService> | null = null;
let quitting = false;
let openSettingsOnReady = process.argv.some(isSettingsLaunchRequest);
let updateDialogActive = false;

/**
 * macOS Cmd+Q confirmation gate: one 3000ms window shared by every
 * accelerator-driven quit request. Direct/programmatic quits bypass it.
 */
const macQuitGate = createMacQuitConfirmationGate({ windowMs: 3_000 });

function showDesktop(page: ShellPage = 'workbench'): void {
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

async function requestInstallFromMenu(): Promise<void> {
  if (!updateController || updateDialogActive) return;
  updateDialogActive = true;
  try {
    const snapshot = await updateController.check(true);
    const actionable = snapshot.state === 'available'
      || snapshot.state === 'waiting'
      || snapshot.state === 'install-blocked'
      || snapshot.state === 'install-failed';
    if (!actionable) {
      const message = snapshot.state === 'stable-unavailable'
        ? '正式版尚未发布'
        : snapshot.state === 'up-to-date'
          ? '啾啾工坊已是最新版本'
          : '暂时无法检查更新';
      await showUpdateMessage({
        type: snapshot.state === 'check-failed' ? 'error' : 'info',
        title: '软件更新',
        message,
        detail: snapshot.message ?? `当前版本为 v${snapshot.currentVersion}。`,
        buttons: ['好'],
        noLink: true,
      });
      return;
    }
    // One click authorizes the whole remaining flow: prepare (staged even while
    // busy), then automatically install once actual work is idle.
    await updateController.requestInstall(() => setImmediate(() => app.quit()));
  } finally {
    updateDialogActive = false;
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  await ensureDesktopActivationPolicy({
    setActivationPolicy: (policy) => app.setActivationPolicy(policy),
    ...(app.dock ? { showDock: () => app.dock!.show() } : {}),
  });
  const ipcPath = resolveWrenyardIpcPath();
  const workspaceConfiguration = await inspectProductWorkspace();

  const requestForeman = async (method: string, params: unknown): Promise<unknown> => {
    const client = new WrenyardIpcClient({ path: ipcPath, requestTimeoutMs: TASK_SETTINGS_REQUEST_TIMEOUT_MS });
    try {
      return await client.request(method, params);
    } finally {
      await client.close?.();
    }
  };
  const readUpdateActiveTaskCount = async (): Promise<number | null> => {
    const conversationCount = conversationController?.snapshot().sessions.filter((item) => item.running).length ?? 0;
    const raw = await requestForeman('daemon.status', {});
    return activeTaskCountFromDaemonStatus(raw, conversationCount);
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
  const saveTaskSettings = async (request: TaskSettingsSaveRequest): Promise<TaskSettingsSnapshot> => {
    const params: Record<string, unknown> = {
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

  await assertForemanHealthy().catch((error: unknown) => {
    console.warn('[wrenyard-desktop] Wrenyard service is unavailable; Desktop settings remain accessible:', error);
  });

  // Workspace-scoped userData preference file: exactly one canonical model id,
  // never a token/provider. Survives restart because it is a plain userData file.
  const summaryPreferenceStore = new SummaryModelPreferenceStore(
    join(app.getPath('userData'), 'conversation-summary.json'),
  );
  conversationSummary = createConversationSummaryService({
    readGatewayConnection: () => readGatewayConnection(ipcPath),
    preferenceStore: summaryPreferenceStore,
  });
  const summarize = (input: ConversationSummaryInput): Promise<string> => {
    if (!conversationSummary) return Promise.reject(new Error('摘要服务未就绪'));
    return conversationSummary.summarize(input);
  };

  conversationController = new DesktopConversationController({
    initialWorkspace: workspaceConfiguration,
    createSession: (workspace, onUnexpectedExit) => createConversationSession(workspace, ipcPath, onUnexpectedExit, summarize),
    onChanged: () => shellWindow?.notifyConversationChanged(),
  });
  await conversationController.start().catch((error: unknown) => {
    console.error('[wrenyard-desktop] DSH conversation backend failed to start:', error);
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const petAssets = resolvePetAssets();
  const petSettings = new DesktopPetSettingsStore({
    path: join(app.getPath('userData'), 'settings.json'),
  });
  const wrenyardCli = resolveWrenyardCli();
  const wrenyardNode = resolveInstallation().runtimePath;
  updateController = new DesktopUpdateController({
    currentVersion: app.getVersion(),
    settings: petSettings,
    cliPath: wrenyardCli,
    helperPath: join(app.getAppPath(), 'dist', 'update-helper.cjs'),
    helperRuntimePath: wrenyardNode,
    // Re-probe on every check/retry/install so a suite repaired after startup
    // becomes installable without restarting Desktop, and a custom CLI never
    // pairs with a stale default runtime.
    probeInstallation: () => resolveInstallation(),
    desktopPath: installedDesktopPath(),
    userDataPath: app.getPath('userData'),
    onInstall: () => setImmediate(() => app.quit()),
    activeTaskCount: readUpdateActiveTaskCount,
    onChanged: () => shellWindow?.notifyUpdateChanged(),
  });
  petController = new DesktopPetController({
    loadConfig: () => petSettings.load(),
    saveConfig: (config) => petSettings.save(config),
    createRuntime: (config, onConfigChange) => new DesktopPetRuntime({
      config,
      ipcPath,
      rendererDir: petAssets.rendererDir,
      preloadDir: petAssets.preloadDir,
      onConfigChange,
      debugRenderer: process.env.PET_DEBUG === '1' || process.env.PET_DEBUG === 'true',
    }),
    listDisplays: () => screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      label: `显示器 ${index + 1}`,
      isPrimary: display.id === screen.getPrimaryDisplay().id,
    })),
  });
  await petController.start().catch((error: unknown) => {
    console.warn('[wrenyard-desktop] Pet module failed to start:', error);
  });
  const providerService = new ProviderService({ ipcPath });
  const clientConfigurationService = new ClientConfigurationDesktopService({ ipcPath });
  quotaController = new DesktopQuotaController({
    source: new QuotaService({ runtimeCommand: resolveQuotaRuntimeBin() }),
    providerSource: providerService,
    getProviderOrder: () => petController!.getConfig().quota.providers,
    onChanged: (_snapshot, providers) => {
      petController?.setQuotaProviders(providers);
      desktopTray?.rebuild();
      shellWindow?.notifyQuotaChanged();
    },
  });
  await quotaController.start();

  /**
   * Reactivate the daemon after a workspace change: gate on an idle daemon,
   * run a planned CLI restart, and only then let the conversation controller
   * bind the saved workspace. Any failure stays visible instead of claiming
   * activation succeeded, and a busy daemon is never interrupted.
   */
  const version = app.getVersion();
  const buildTime = resolveDesktopBuildTime();
  const getSettings = () => buildSettingsSnapshot({
    endpoint: ipcPath,
    workspace: conversationController!.workspace,
    desktopVersion: version,
    wrenyardVersion: version,
    dshVersion: resolveDshVersion(),
    buildTime,
    readHealth: () => readWrenyardHealth(ipcPath),
    readGatewayModels: () => readGatewayConnection(ipcPath).then((connection) => connection.models),
    readPet: async () => petController!.snapshot(),
    readUpdate: () => updateController!.snapshot(),
  });
  shellWindow = await ShellWindowController.create({
    rendererPath: join(app.getAppPath(), 'dist', 'renderer', 'index.html'),
    preloadPath: join(app.getAppPath(), 'dist', 'preload.cjs'),
    appVersion: version,
    smoke: SMOKE,
    icon: resolveAppIcon(),
    getSettings,
    getStats: () => readStatsSnapshot(ipcPath),
    getQuota: (forceRefresh = false) => quotaController!.getSnapshot(forceRefresh),
    saveProviderOrder: async (providerIds: string[]) => {
      await petController!.saveProviderOrder(providerIds);
      return quotaController!.notifyConfigurationChanged();
    },
    configureProviderKey: async (providerId: string, key: string) => {
      await providerService.configureApiKey(providerId, key);
      // A fresh key can change the gateway's model routes: refresh the
      // conversation backend's model patch (deferred while turns run) so the
      // new routes become selectable without an app restart.
      await refreshConversationBackendAfterProviderChange(ipcPath);
      return quotaController!.getSnapshot(true);
    },
    getClientConfiguration: () => clientConfigurationService.snapshot(),
    planClientConfiguration: (clientId, selection) => clientConfigurationService.plan(clientId, selection),
    applyClientConfiguration: (plan) => clientConfigurationService.apply(plan),
    planClientConfigurationRestore: (clientId) => clientConfigurationService.planRestore(clientId),
    restoreClientConfiguration: (plan) => clientConfigurationService.restore(plan),
    getUpdate: async () => updateController!.snapshot(),
    checkUpdate: () => updateController!.check(true),
    setUpdateChannel: (channel) => updateController!.setChannel(channel),
    requestInstall: (onInstall) => updateController!.requestInstall(onInstall),
    cancelPendingInstall: async () => updateController!.cancelPendingInstall(),
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
      const cli = resolveWrenyardCli();
      if (!cli) throw new Error('未找到 Wrenyard CLI，无法应用工作区');
      const idle = assertDaemonIdle(await requestForeman('daemon.status', {}));
      if (!idle.idle) throw new Error(idle.reason);
      const saved = create ? await createProductWorkspace(path) : await saveProductWorkspace(path);
      await runPlannedDaemonRestart({ cli });
      await conversationController!.configure(saved);
      // configure() spawns a fresh backend reading the current gateway
      // connection, so any deferred provider refresh is already satisfied.
      pendingModelRefreshRebuild = false;
      return saved;
    },
    getConversation: async () => conversationController!.snapshot(),
    getConversationActivity: () => readConversationActivity(ipcPath),
    openTaskTranscript: (taskRunId) => petController!.openTaskTranscript(taskRunId),
    selectConversation: (sessionId: string) => conversationController!.select(sessionId),
    createConversation: () => conversationController!.create(),
    selectConversationModel: (provider: string, model: string, reasoningEffort?: string) => conversationController!.selectModel(provider, model, reasoningEffort),
    sendConversation: (text: string, clientTimeZone?: string) => conversationController!.send(text, clientTimeZone),
    cancelConversation: (turnId?: string) => conversationController!.cancel(turnId),
    getTaskSettings: (project?: string, taskId?: string) => getTaskSettings(project, taskId),
    saveTaskSettings: (request: TaskSettingsSaveRequest) => saveTaskSettings(request),
    runtimeAliasSnapshot: () => getRuntimeAliasSnapshot(),
    runtimeAliasPut: (request: RuntimeAliasPutRequest) => putRuntimeAlias(request),
    runtimeAliasRemove: (request: RuntimeAliasRemoveRequest) => removeRuntimeAlias(request),
    requestTaskRoutingTest: (params: TaskRoutingTestParams) => requestTaskRoutingTest(params),
    requestRoutingTestTasks: () => requestRoutingTestTasks(),
    getSummarySettings: () => buildSummarySettingsSnapshot({
      readGatewayConnection: () => readGatewayConnection(ipcPath),
      readSummaryModel: () => conversationSummary!.selectedModel(),
    }),
    saveSummaryModel: async (canonicalModel: string): Promise<SummarySettingsSnapshot> => {
      if (conversationSummary) {
        // Persist only the canonical model id (no token/provider).
        summaryPreferenceStore.save(canonicalModel);
      }
      return buildSummarySettingsSnapshot({
        readGatewayConnection: () => readGatewayConnection(ipcPath),
        readSummaryModel: () => conversationSummary!.selectedModel(),
      });
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(desktopMenuTemplate(
    process.platform,
    () => { void requestInstallFromMenu(); },
    (origin: QuitOrigin) => {
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
  if (!SMOKE) updateController.start();

  shellWindow.window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    shellWindow?.window.hide();
  });

  desktopTray = createDesktopTray({
    getPetConfig: () => petController!.getConfig(),
    setPetEntityVisibility: (key, visible) => petController!.setEntityVisibility(key, visible),
    selectPetDisplay: (displayId) => petController!.selectDisplay(displayId),
    setPetEnabled: (enabled) => petController!.setEnabled(enabled),
    restartPet: () => petController!.restart(),
    openDesktop: () => showDesktop('workbench'),
    getQuotaSnapshot: () => quotaController!.snapshot(),
  }, process.platform);

  if (openSettingsOnReady) {
    openSettingsOnReady = false;
    shellWindow.setPage('settings', false);
  }

  startGatewayRecoveryWatcher(ipcPath);

  if (SMOKE) {
    if (conversationController.snapshot().status !== 'ready') {
      throw new Error('smoke requires a configured workspace and DSH backend');
    }
    await runSmoke(shellWindow);
    await runSmokeWindowLifecycle(shellWindow);
    console.log('[wrenyard-desktop] smoke ok');
    // Real explicit quit: the production before-quit handler owns all teardown.
    app.quit();
  }
}

app.on('second-instance', (_event, commandLine) => {
  showDesktop(commandLine.some(isSettingsLaunchRequest) ? 'settings' : 'workbench');
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (isSettingsLaunchRequest(url)) showDesktop('settings');
});

app.on('activate', () => showDesktop('workbench'));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void (async () => {
    try {
      stopGatewayRecoveryWatcher();
      desktopTray?.destroy();
      desktopTray = null;
      quotaController?.stop();
      quotaController = null;
      updateController?.stop();
      updateController = null;
      await petController?.stop();
      petController = null;
      await conversationController?.stop();
      conversationController = null;
    } catch {
      // best-effort termination
    } finally {
      app.quit();
    }
  })();
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
      stopGatewayRecoveryWatcher();
      quotaController?.stop();
      quotaController = null;
      updateController?.stop();
      updateController = null;
      await petController?.stop();
      await conversationController?.stop();
      conversationController = null;
    } catch {
      // best-effort termination
    }
    app.exit(1);
  });
}
