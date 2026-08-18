import { app, BrowserWindow, session } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WrenyardIpcClient, resolveWrenyardIpcPath } from '@wrenyard/control-client';
import { startDshWeb, type DshWebHandle } from './dsh-process.js';
import { defaultMcpUrl, resolveModelCredentialEnv, writeModelPatch } from './model-patch.js';
import { prepareProfile } from './profile.js';

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

/** True when health.ping succeeds on the given IPC socket. */
async function probeWrenyard(path: string): Promise<boolean> {
  let client: WrenyardIpcClient | null = null;
  try {
    client = new WrenyardIpcClient({ path, requestTimeoutMs: FOREMAN_HEALTH_TIMEOUT_MS });
    const result: unknown = await client.request('health.ping');
    return !(result != null && typeof result === 'object' && 'ok' in result && result.ok === false);
  } catch {
    return false;
  } finally {
    await client?.close?.();
  }
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

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const origin = new URL(url).origin;

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, targetUrl) => {
    let target: URL;
    try {
      target = new URL(targetUrl);
    } catch {
      event.preventDefault();
      return;
    }
    if (target.origin !== origin) event.preventDefault();
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  win.once('ready-to-show', () => {
    if (!SMOKE) win.show();
  });

  return win;
}

function errorPage(code: number | null, signal: string | null): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Wrenyard Desktop</title></head>',
    '<body style="background:#0f1115;color:#e6e6e6;font-family:system-ui,sans-serif;padding:3rem;line-height:1.5">',
    '<h1>DSH stopped</h1>',
    `<p>The DSH web process exited unexpectedly (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).</p>`,
    '<p>Restart the application to relaunch DSH.</p>',
    '</body></html>',
  ].join('\n');
}

async function runSmoke(win: BrowserWindow, url: string): Promise<void> {
  await new Promise<void>((resolveSmoke, rejectSmoke) => {
    const timer = setTimeout(() => {
      console.error('[wrenyard-desktop] smoke timed out');
      rejectSmoke(new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`));
    }, SMOKE_TIMEOUT_MS);

    win.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          const bodyOk = await win.webContents.executeJavaScript('document.body ? document.body.innerText.length > 0 : false');
          const response = await fetch(url);
          clearTimeout(timer);
          if (bodyOk && response.ok) {
            resolveSmoke();
          } else {
            console.error(`[wrenyard-desktop] smoke failed (body=${bodyOk}, health=${response.ok})`);
            rejectSmoke(new Error(`smoke failed (body=${bodyOk}, health=${response.ok})`));
          }
        } catch (error) {
          clearTimeout(timer);
          console.error('[wrenyard-desktop] smoke failed:', error);
          rejectSmoke(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  });
}

let dsh: DshWebHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

async function bootstrap(): Promise<void> {
  await app.whenReady();
  await assertForemanHealthy();

  const shellSource = resolveShellSource();
  const dshHome = join(app.getPath('userData'), 'dsh');
  const runtimeModules = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : join(app.getAppPath(), 'node_modules');
  const profile = await prepareProfile(dshHome, shellSource, runtimeModules);
  const workspace = process.env.WRENYARD_DESKTOP_WORKSPACE ?? homedir();
  const patchPath = await writeModelPatch(profile.dshHome);
  const extraEnv = await resolveModelCredentialEnv();

  // Connection context for the DSH child. Explicit Wrenyard values are always
  // propagated (LaunchServices supplies no shell env, so the resolved IPC path
  // cannot be assumed to reach the child via inheritance). MCP defaults to the
  // same loopback endpoint the dsh-shell Foreman bridge uses.
  const wrenyardEnv: NodeJS.ProcessEnv = {
    WRENYARD_IPC_PATH: resolveWrenyardIpcPath(),
    WRENYARD_MCP_URL: defaultMcpUrl(),
  };
  const sender = process.env.WRENYARD_MCP_SENDER ?? process.env.FOREMAN_MCP_SENDER;
  if (sender) wrenyardEnv.WRENYARD_MCP_SENDER = sender;

  dsh = await startDshWeb({
    binPath: resolveDshBin(),
    profileHome: profile.dshHome,
    workspace,
    runAsElectron: true,
    wrenyardEnv,
    patchPath,
    extraEnv,
  });

  dsh.child.on('exit', (code, signal) => {
    if (quitting) return;
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(errorPage(code, signal))}`;
    if (mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(dataUrl);
    } else {
      mainWindow = createWindow(dataUrl);
      void mainWindow.loadURL(dataUrl);
    }
  });

  mainWindow = createWindow(dsh.url);
  void mainWindow.loadURL(dsh.url);

  if (SMOKE) {
    await runSmoke(mainWindow, dsh.url);
    await dsh.stop();
    dsh = null;
    console.log('[wrenyard-desktop] smoke ok');
    app.exit(0);
  }
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
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
  void bootstrap().catch(async (error) => {
    console.error('[wrenyard-desktop] startup failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    try {
      await dsh?.stop();
    } catch {
      // best-effort termination
    }
    dsh = null;
    app.exit(1);
  });
}
