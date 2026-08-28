import { app, screen, session } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WrenyardIpcClient, resolveWrenyardIpcPath } from '@wrenyard/control-client';
import { DesktopPetRuntime, QuotaService } from '@wrenyard/pet/runtime';
import { startDshWeb, type DshWebHandle } from './dsh-process.js';
import { DshConversationClient, unavailableConversation } from './dsh-conversation-client.js';
import { defaultMcpUrl, resolveModelCredentialEnv, writeModelPatch } from './model-patch.js';
import { prepareProfile } from './profile.js';
import { createDesktopTray, type DesktopTrayHandle } from './desktop-tray.js';
import { DesktopPetController } from './pet-controller.js';
import { DesktopPetSettingsStore } from './pet-settings-store.js';
import { DesktopQuotaController } from './quota-controller.js';
import { buildSettingsSnapshot, type HealthSnapshot } from './settings-snapshot.js';
import { readStatsSnapshot } from './stats-snapshot.js';
import { isSettingsLaunchRequest, type PetCompanionSettings, type ShellPage } from './shell-contract.js';
import { ShellWindowController } from './shell-window.js';
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
    join(process.cwd(), 'wrenyard'),
    join(homedir(), '.local', 'bin', 'wrenyard'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
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

/** Start the Wrenyard daemon service once, detached from the app process. */
function startWrenyardService(cli: string): void {
  const child = spawn(cli, ['daemon', 'start'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
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
        "window.wrenyardShell.getSettings().then((value) => value?.pet?.settings?.entities && Array.isArray(value?.pet?.settings?.quota?.providers)).catch(() => false)",
      ),
      shell.window.webContents.executeJavaScript(
        "window.wrenyardShell.getConversation().then((value) => value?.status === 'ready' && Array.isArray(value?.sessions)).catch(() => false)",
      ),
      shell.window.webContents.executeJavaScript(
        "window.wrenyardShell.getQuota().then((value) => (value?.status === 'available' || value?.status === 'unavailable') && Array.isArray(value?.providers)).catch(() => false)",
      ),
    ]);
    shell.setPage('settings', false);
    const settingsVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'settings'",
    );
    shell.setPage('stats', false);
    const statsVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'stats' && window.wrenyardShell.getStats().then((value) => value?.status === 'available' || value?.status === 'unavailable').catch(() => false)",
    );
    shell.setPage('quota', false);
    const quotaVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'quota' && document.getElementById('quota-provider-grid') !== null",
    );
    shell.setPage('workbench', false);
    const workbenchVisible = await shell.window.webContents.executeJavaScript(
      "document.documentElement.dataset.page === 'workbench' && document.getElementById('conversation-composer') !== null",
    );
    if (!shellOk || !snapshotOk || !conversationOk || !quotaOk || !settingsVisible || !statsVisible || !quotaVisible || !workbenchVisible) {
      throw new Error(
        `smoke failed (shell=${shellOk}, snapshot=${snapshotOk}, conversation=${conversationOk}, quota=${quotaOk}, settings=${settingsVisible}, stats=${statsVisible}, quotaPage=${quotaVisible}, workbench=${workbenchVisible})`,
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

let dsh: DshWebHandle | null = null;
let conversation: DshConversationClient | null = null;
let shellWindow: ShellWindowController | null = null;
let desktopTray: DesktopTrayHandle | null = null;
let petController: DesktopPetController | null = null;
let quotaController: DesktopQuotaController | null = null;
let quitting = false;
let openSettingsOnReady = process.argv.some(isSettingsLaunchRequest);

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

async function bootstrap(): Promise<void> {
  await app.whenReady();
  const ipcPath = resolveWrenyardIpcPath();
  const workspaceConfiguration = await inspectProductWorkspace();
  let conversationError: string | undefined;

  await assertForemanHealthy().catch((error: unknown) => {
    console.warn('[wrenyard-desktop] Wrenyard service is unavailable; Desktop settings remain accessible:', error);
  });

  if (workspaceConfiguration.status === 'configured' && workspaceConfiguration.path) {
    try {
      const shellSource = resolveShellSource();
      const dshHome = join(app.getPath('userData'), 'dsh');
      const runtimeModules = app.isPackaged
        ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
        : join(app.getAppPath(), 'node_modules');
      const profile = await prepareProfile(dshHome, shellSource, runtimeModules);
      ensureChineseLocale(profile.dshHome);
      const registration = await ensureProductWorkspaceRegistered(profile.dshHome, workspaceConfiguration.path);
      const patchPath = await writeModelPatch(profile.dshHome);
      const extraEnv = await resolveModelCredentialEnv();

      // The DSH process remains the conversation backend. Its Web UI is not
      // embedded: Desktop owns the only renderer and talks through bounded IPC.
      const wrenyardEnv: NodeJS.ProcessEnv = {
        WRENYARD_IPC_PATH: ipcPath,
        WRENYARD_MCP_URL: defaultMcpUrl(),
      };
      const sender = process.env.WRENYARD_MCP_SENDER ?? process.env.FOREMAN_MCP_SENDER;
      if (sender) wrenyardEnv.WRENYARD_MCP_SENDER = sender;

      dsh = await startDshWeb({
        binPath: resolveDshBin(),
        profileHome: profile.dshHome,
        workspace: workspaceConfiguration.path,
        runAsElectron: true,
        wrenyardEnv,
        patchPath,
        extraEnv,
      });
      conversation = new DshConversationClient({
        baseUrl: dsh.url,
        workspaceId: registration.id,
        workspace: {
          ...workspaceConfiguration,
          status: 'configured',
          path: workspaceConfiguration.path,
        },
        onChanged: () => shellWindow?.notifyConversationChanged(),
      });
      await conversation.start();

      dsh.child.on('exit', (code, signal) => {
        if (quitting) return;
        conversation?.stop();
        conversation = null;
        conversationError = `DSH 会话后端已停止（code ${code ?? 'unknown'}，signal ${signal ?? 'none'}）`;
        shellWindow?.notifyConversationChanged();
      });
    } catch (error) {
      conversationError = error instanceof Error ? error.message : String(error);
      console.error('[wrenyard-desktop] DSH conversation backend failed to start:', error);
      conversation?.stop();
      conversation = null;
      await dsh?.stop().catch(() => undefined);
      dsh = null;
    }
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const petAssets = resolvePetAssets();
  const petSettings = new DesktopPetSettingsStore({
    path: join(app.getPath('userData'), 'settings.json'),
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
  quotaController = new DesktopQuotaController({
    source: new QuotaService({ runtimeCommand: resolveQuotaRuntimeBin() }),
    getProviderOrder: () => petController!.getConfig().quota.providers,
    onChanged: (_snapshot, providers) => {
      petController?.setQuotaProviders(providers);
      desktopTray?.rebuild();
      shellWindow?.notifyQuotaChanged();
    },
  });
  await quotaController.start();
  const version = app.getVersion();
  const getSettings = () => buildSettingsSnapshot({
    endpoint: ipcPath,
    workspace: workspaceConfiguration,
    desktopVersion: version,
    wrenyardVersion: version,
    dshVersion: resolveDshVersion(),
    readHealth: () => readWrenyardHealth(ipcPath),
    readPet: async () => petController!.snapshot(),
  });
  shellWindow = await ShellWindowController.create({
    rendererPath: join(app.getAppPath(), 'dist', 'renderer', 'index.html'),
    preloadPath: join(app.getAppPath(), 'dist', 'preload.cjs'),
    smoke: SMOKE,
    icon: resolveAppIcon(),
    getSettings,
    getStats: () => readStatsSnapshot(ipcPath),
    getQuota: (forceRefresh = false) => quotaController!.getSnapshot(forceRefresh),
    savePetSettings: async (settings: PetCompanionSettings) => {
      await petController!.saveSettings(settings);
      quotaController?.notifyConfigurationChanged();
      return getSettings();
    },
    saveWorkspace: async (path: string) => {
      const saved = await saveProductWorkspace(path);
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 350);
      return saved;
    },
    getConversation: async () => conversation?.snapshot()
      ?? unavailableConversation(workspaceConfiguration, conversationError),
    selectConversation: async (sessionId: string) => {
      if (!conversation) throw new Error(conversationError ?? '请先配置 Wrenyard workspace');
      return conversation.select(sessionId);
    },
    createConversation: async () => {
      if (!conversation) throw new Error(conversationError ?? '请先配置 Wrenyard workspace');
      return conversation.create();
    },
    sendConversation: async (text: string, clientTimeZone?: string) => {
      if (!conversation) throw new Error(conversationError ?? '请先配置 Wrenyard workspace');
      return conversation.send(text, clientTimeZone);
    },
    cancelConversation: async () => {
      if (!conversation) throw new Error(conversationError ?? '请先配置 Wrenyard workspace');
      return conversation.cancel();
    },
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
    if (!conversation) throw new Error('smoke requires a configured workspace and DSH backend');
    await runSmoke(shellWindow);
    await petController.stop();
    petController = null;
    quotaController.stop();
    quotaController = null;
    conversation.stop();
    conversation = null;
    await dsh?.stop();
    dsh = null;
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
      conversation?.stop();
      conversation = null;
      quotaController?.stop();
      quotaController = null;
      await petController?.stop();
      petController = null;
      await dsh?.stop();
    } catch {
      // best-effort termination
    } finally {
      dsh = null;
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
      conversation?.stop();
      conversation = null;
      quotaController?.stop();
      quotaController = null;
      await petController?.stop();
      await dsh?.stop();
    } catch {
      // best-effort termination
    }
    dsh = null;
    app.exit(1);
  });
}
