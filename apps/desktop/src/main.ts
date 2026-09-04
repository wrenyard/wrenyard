import { app, dialog, Menu, screen, session, type MessageBoxOptions } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WrenyardIpcClient, resolveWrenyardIpcPath, type WrenyardGatewayConnection } from '@wrenyard/control-client';
import { DesktopPetRuntime, QuotaService } from '@wrenyard/pet/runtime';
import { startDshWeb } from './dsh-process.js';
import { DshConversationClient } from './dsh-conversation-client.js';
import {
  DesktopConversationController,
  type ConfiguredWorkspace,
  type DesktopConversationSession,
} from './conversation-controller.js';
import { defaultMcpUrl, WRENYARD_DSH_PROVIDER_ID, WRENYARD_GATEWAY_TOKEN_ENV, writeModelPatch } from './model-patch.js';
import { prepareProfile } from './profile.js';
import { createDesktopTray, type DesktopTrayHandle } from './desktop-tray.js';
import { ensureDesktopActivationPolicy } from './desktop-activation-policy.js';
import { DesktopPetController } from './pet-controller.js';
import { DesktopPetSettingsStore } from './pet-settings-store.js';
import { DesktopQuotaController } from './quota-controller.js';
import { ProviderService } from './provider-service.js';
import { ClientConfigurationDesktopService } from './client-configuration/service.js';
import { buildSettingsSnapshot, type HealthSnapshot } from './settings-snapshot.js';
import { readStatsSnapshot } from './stats-snapshot.js';
import { isSettingsLaunchRequest, type PetCompanionSettings, type ShellPage } from './shell-contract.js';
import { ShellWindowController } from './shell-window.js';
import { DesktopUpdateController, wrenyardIsBusy } from './update-controller.js';
import { resolveDesktopBuildTime } from './build-metadata.js';
import { desktopMenuTemplate } from './app-menu.js';
import {
  ensureProductWorkspaceRegistered,
  inspectProductWorkspace,
  saveProductWorkspace,
} from './workspace.js';

const SMOKE = process.env.WRENYARD_DESKTOP_SMOKE === '1' || process.argv.includes('--smoke');
const FOREMAN_HEALTH_TIMEOUT_MS = 5_000;
const SERVICE_RETRY_ATTEMPTS = 10;
const SERVICE_RETRY_DELAY_MS = 500;
const SMOKE_TIMEOUT_MS = 30_000;

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
 * Locate the installed Wrenyard CLI: an explicit WRENYARD_CLI env var, the
 * current working directory, or ~/.local/bin. LaunchServices provides no shell
 * profile, so the CLI is located explicitly instead of relying on an inherited
 * PATH.
 */
function resolveWrenyardCli(): string | undefined {
  const candidates = [
    process.env.WRENYARD_CLI,
    join(process.cwd(), process.platform === 'win32' ? 'wrenyard.exe' : 'wrenyard'),
    ...(process.platform === 'win32'
      ? [
        join(process.env.LOCALAPPDATA ?? '', 'wrenyard', 'current', 'wrenyard.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'wrenyard', 'bin', 'wrenyard.cmd'),
      ]
      : [join(homedir(), '.local', 'bin', 'wrenyard')]),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveWrenyardNode(): string | undefined {
  const candidates = [
    process.env.WRENYARD_NODE_BIN,
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? '', 'wrenyard', 'current', 'runtime', 'node.exe')
      : join(homedir(), '.local', 'share', 'wrenyard', 'current', 'runtime', 'node'),
  ];
  return candidates.find((candidate) => Boolean(candidate && existsSync(candidate)));
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
        "window.wrenyardShell.getQuota().then((value) => (value?.status === 'available' || value?.status === 'unavailable') && Array.isArray(value?.providers) && value.providers.every((provider) => value.catalog?.some((entry) => entry.id === provider.id && entry.configured === true && entry.quota))).catch(() => false)",
      ),
    ]);
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
    shell.setPage('clients', false);
    const clientsVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'clients' && window.wrenyardShell.getClientConfiguration().then((value) => Array.isArray(value?.surfaces) && Array.isArray(value?.configurations) && Array.isArray(value?.models)).catch(() => false)",
    );
    shell.setPage('workbench', false);
    const workbenchVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'workbench' && document.getElementById('conversation-composer') !== null && document.getElementById('conversation-model-trigger') instanceof HTMLButtonElement && document.getElementById('conversation-model-list')?.getAttribute('role') === 'listbox'",
    );
    if (!shellOk || !snapshotOk || !conversationOk || !quotaOk || !settingsVisible || !statsVisible || !quotaVisible || !clientsVisible || !workbenchVisible) {
      throw new Error(
        `smoke failed (shell=${shellOk}, snapshot=${snapshotOk}, conversation=${conversationOk}, quota=${quotaOk}, settings=${settingsVisible}, stats=${statsVisible}, quotaPage=${quotaVisible}, clients=${clientsVisible}, workbench=${workbenchVisible})`,
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

async function createConversationSession(
  workspace: ConfiguredWorkspace,
  ipcPath: string,
  onUnexpectedExit: (message: string) => void,
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

  return {
    snapshot: () => client.snapshot(),
    select: (sessionId) => client.select(sessionId),
    create: () => client.create(),
    selectModel: (provider, model) => client.selectModel(provider, model),
    send: (text, clientTimeZone) => client.send(text, clientTimeZone),
    cancel: () => client.cancel(),
    stop: async () => {
      intentionalStop = true;
      client.stop();
      await dsh.stop();
    },
  };
}

let conversationController: DesktopConversationController | null = null;
let shellWindow: ShellWindowController | null = null;
let desktopTray: DesktopTrayHandle | null = null;
let petController: DesktopPetController | null = null;
let quotaController: DesktopQuotaController | null = null;
let updateController: DesktopUpdateController | null = null;
let quitting = false;
let openSettingsOnReady = process.argv.some(isSettingsLaunchRequest);
let updateDialogActive = false;

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

async function promptForPreparedUpdate(version: string): Promise<void> {
  const decision = await showUpdateMessage({
    type: 'info',
    title: '软件更新',
    message: `啾啾工坊 v${version} 已准备好`,
    detail: '重启后将原子替换啾啾工坊与 Wrenyard suite；失败时会自动恢复当前版本。',
    buttons: ['重启并安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (decision.response !== 0 || !updateController) return;
  if (await updateController.launchPreparedUpdate()) {
    setImmediate(() => app.quit());
    return;
  }
  const failed = updateController.snapshot();
  await showUpdateMessage({
    type: 'error',
    title: '软件更新',
    message: '暂时无法开始安装',
    detail: failed.message ?? '更新仍已保留，可稍后重试。',
    buttons: ['好'],
    noLink: true,
  });
}

async function checkForUpdatesFromMenu(): Promise<void> {
  if (!updateController || updateDialogActive) return;
  updateDialogActive = true;
  try {
    const snapshot = await updateController.check(true);
    if (snapshot.state === 'restart-required' && snapshot.availableVersion) {
      await promptForPreparedUpdate(snapshot.availableVersion);
      return;
    }
    if (snapshot.state === 'available' && snapshot.availableVersion) {
      const decision = await showUpdateMessage({
        type: 'info',
        title: '软件更新',
        message: `啾啾工坊 v${snapshot.availableVersion} 可用`,
        detail: `当前版本为 v${snapshot.currentVersion}。下载完成后，你可以选择何时重启安装。`,
        buttons: ['下载更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (decision.response !== 0) return;
      const prepared = await updateController.prepareUpdate();
      if (prepared.state === 'restart-required' && prepared.availableVersion) {
        await promptForPreparedUpdate(prepared.availableVersion);
        return;
      }
      await showUpdateMessage({
        type: 'error',
        title: '软件更新',
        message: '更新未能准备完成',
        detail: prepared.message ?? '当前版本未受影响，请稍后重试。',
        buttons: ['好'],
        noLink: true,
      });
      return;
    }
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

  await assertForemanHealthy().catch((error: unknown) => {
    console.warn('[wrenyard-desktop] Wrenyard service is unavailable; Desktop settings remain accessible:', error);
  });

  conversationController = new DesktopConversationController({
    initialWorkspace: workspaceConfiguration,
    createSession: (workspace, onUnexpectedExit) => createConversationSession(workspace, ipcPath, onUnexpectedExit),
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
  const wrenyardNode = resolveWrenyardNode();
  updateController = new DesktopUpdateController({
    currentVersion: app.getVersion(),
    settings: petSettings,
    cliPath: wrenyardCli,
    helperPath: join(app.getAppPath(), 'dist', 'update-helper.cjs'),
    helperRuntimePath: wrenyardNode,
    desktopPath: installedDesktopPath(),
    userDataPath: app.getPath('userData'),
    isBusy: async () => {
      const conversationBusy = conversationController?.snapshot().sessions.some((item) => item.running) === true;
      return conversationBusy || await wrenyardIsBusy(wrenyardCli);
    },
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
      if (conversationController) {
        await conversationController.configure(conversationController.workspace);
      }
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
    prepareUpdate: () => updateController!.prepareUpdate(),
    restartUpdate: async () => {
      if (await updateController!.launchPreparedUpdate()) setImmediate(() => app.quit());
    },
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
    saveWorkspace: async (path: string) => {
      const saved = await saveProductWorkspace(path);
      await conversationController!.configure(saved);
      return saved;
    },
    getConversation: async () => conversationController!.snapshot(),
    selectConversation: (sessionId: string) => conversationController!.select(sessionId),
    createConversation: () => conversationController!.create(),
    selectConversationModel: (provider: string, model: string) => conversationController!.selectModel(provider, model),
    sendConversation: (text: string, clientTimeZone?: string) => conversationController!.send(text, clientTimeZone),
    cancelConversation: () => conversationController!.cancel(),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(desktopMenuTemplate(
    process.platform,
    () => { void checkForUpdatesFromMenu(); },
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
  });

  if (openSettingsOnReady) {
    openSettingsOnReady = false;
    shellWindow.setPage('settings', false);
  }

  if (SMOKE) {
    if (conversationController.snapshot().status !== 'ready') {
      throw new Error('smoke requires a configured workspace and DSH backend');
    }
    await runSmoke(shellWindow);
    await petController.stop();
    petController = null;
    quotaController.stop();
    quotaController = null;
    await conversationController.stop();
    conversationController = null;
    console.log('[wrenyard-desktop] smoke ok');
    app.exit(0);
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
  if (app.isPackaged) app.setAsDefaultProtocolClient('wrenyard');
  void bootstrap().catch(async (error) => {
    console.error('[wrenyard-desktop] startup failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    try {
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
