#!/usr/bin/env node
// Isolated cross-platform Desktop/DSH core smoke harness.
//
// Unlike the configured live smoke (apps/desktop `smoke` script), this harness
// never requires a user's real Wrenyard state, credentials or network model
// access. It provisions a throwaway HOME/state/config/db plus a temp registered
// workspace, launches the real Foreman daemon and the real Electron/DSH child,
// and drives the Desktop `--smoke` assertions over the real IPC/Gateway. It
// registers a synthetic provider credential and asserts provider/gateway
// metadata only; it never binds a provider endpoint and performs no model calls.
// The coverage is isolated real daemon/Gateway/DSH metadata and UI smoke.
//
// Default mode launches the built repo binaries. With --release-dir DIR the
// harness consumes an already-built release directory (`release:local` output),
// extracts the platform-qualified suite + Desktop ZIPs, verifies their checksum
// sidecars, and launches the packaged executables. It never rebuilds anything.
//
// Every process and temp directory this harness owns is torn down in finally;
// a failed assertion exits nonzero.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const DEFAULT_TIMEOUT_MS = process.platform === 'win32' ? 300_000 : 180_000;
const DAEMON_START_TIMEOUT_MS = 60_000;
const SMOKE_PROVIDER_ID = 'openai';
const SMOKE_PROVIDER_KEY = 'smoke-fixture-key';

function parseArgs(argv) {
  const options = { releaseDir: null, timeoutMs: DEFAULT_TIMEOUT_MS, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--release-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--release-dir requires a value');
      options.releaseDir = path.resolve(value);
      index += 1;
    } else if (arg.startsWith('--release-dir=')) {
      options.releaseDir = path.resolve(arg.slice('--release-dir='.length));
    } else if (arg === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout-ms requires a positive integer');
      options.timeoutMs = value;
      index += 1;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/release/smoke-desktop.mjs [--release-dir DIR] [--timeout-ms MS] [--keep]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function log(message) {
  console.log(`[desktop-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readChecksum(shaPath) {
  return fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
}

// ── Platform host target (mirrors tools/release/platform.mjs narrowly) ───────

function hostTriplet() {
  const key = `${process.platform}-${process.arch}`;
  if (key === 'darwin-arm64' || key === 'darwin-x64' || key === 'linux-x64' || key === 'win32-x64') {
    return key;
  }
  fail(`unsupported smoke host target: ${key}`);
}

// ── Process helpers ──────────────────────────────────────────────────────────

function resolveCommand(cmd, platform = process.platform) {
  const windowsPackageManager = platform === 'win32' && (cmd === 'npm' || cmd === 'pnpm');
  const windowsShim = platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd);
  return {
    executable: windowsPackageManager ? `${cmd}.cmd` : cmd,
    shell: windowsPackageManager || windowsShim,
  };
}

function run(cmd, args, opts = {}) {
  const invocation = resolveCommand(cmd);
  const res = spawnSync(invocation.executable, args, {
    encoding: 'utf8',
    shell: invocation.shell,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const detail = `${res.stderr ?? ''}\n${res.stdout ?? ''}`.trim().slice(-4000);
    throw new Error(`command failed: ${cmd} ${args.join(' ')} (exit ${res.status})\n${detail}`);
  }
  return res;
}

function isJavaScriptLauncher(file) {
  return /\.(?:mjs|cjs|js)$/i.test(file);
}

function spawnWrenyard(launcher, args, opts = {}) {
  if (isJavaScriptLauncher(launcher)) {
    return spawn(process.execPath, [launcher, ...args], { ...opts, shell: false });
  }
  return spawn(launcher, args, { ...opts, shell: false });
}

function runWrenyard(launcher, args, opts = {}) {
  if (isJavaScriptLauncher(launcher)) {
    return spawnSync(process.execPath, [launcher, ...args], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      ...opts,
    });
  }
  return spawnSync(launcher, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    ...opts,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(200);
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function killPid(pid, signal) {
  if (!pid || !isAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

async function terminateTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && isAlive(pid)) await sleep(100);
  if (isAlive(pid) && process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

async function terminatePid(pid) {
  if (!pid || !isAlive(pid)) return;
  killPid(pid, 'SIGTERM');
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && isAlive(pid)) await sleep(100);
  if (isAlive(pid)) killPid(pid, 'SIGKILL');
}

// ── Temp workspace + IPC/port allocation ─────────────────────────────────────

function mktempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function findFreePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A short IPC endpoint keeps Unix socket paths within the ~104 byte limit and
// gives Windows a unique named pipe.
function resolveTempIpcPath(name) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrenyard-smoke-${process.pid}-${name}`;
  }
  const base = fs.realpathSync('/tmp');
  return path.join(base, `wrenyard-smoke-${process.pid}-${name}.sock`);
}

function isIpcReachable(ipcPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection(ipcPath);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function ipcRequest(ipcPath, method, params = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(ipcPath);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`IPC ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let message;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(error);
        return;
      }
      if (message.error) {
        const detail = message.error.message ?? JSON.stringify(message.error);
        finish(new Error(`IPC ${method} failed: ${detail}`));
        return;
      }
      finish(undefined, message.result);
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => {
      if (!settled) finish(new Error(`IPC ${method} closed without a response`));
    });
  });
}

// ── Isolated environment ─────────────────────────────────────────────────────

function createIsolation(baseDir) {
  const home = path.join(baseDir, 'home');
  const stateHome = path.join(baseDir, 'state');
  const configHome = path.join(baseDir, 'config');
  const dataHome = path.join(baseDir, 'data');
  const appData = path.join(baseDir, 'appdata');
  const localAppData = path.join(baseDir, 'localappdata');
  for (const dir of [home, stateHome, configHome, dataHome, appData, localAppData]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Only OS launch variables are inherited; host provider secrets/config
  // overrides (e.g. CODEX_HOME, CLAUDE_CONFIG_DIR, ACC_PRODUCT_CONFIG_PATH,
  // NODE_OPTIONS, provider keys) are intentionally dropped so the fake HOME
  // and isolated config/state/data actually take effect.
  const names = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'DISPLAY',
    'WAYLAND_DISPLAY', 'XAUTHORITY', 'CI', 'TERM',
  ]);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())),
  );
  const env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_STATE_HOME: path.join(baseDir, 'xdg-state'),
    XDG_CONFIG_HOME: path.join(baseDir, 'xdg-config'),
    XDG_DATA_HOME: dataHome,
    WRENYARD_CONFIG_HOME: configHome,
    WRENYARD_STATE_HOME: stateHome,
    FOREMAN_DB_PATH: path.join(stateHome, 'wrenyard.db'),
  };
  return { home, stateHome, configHome, dataHome, appData, localAppData, env };
}

function writeManagedProviderAuth(dataHome, providerId, key) {
  const authPath = path.join(dataHome, 'wrenyard', 'runtime', 'auth.json');
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, `${JSON.stringify({ [providerId]: { type: 'api', key } }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return authPath;
}

function registerWorkspaceProject(workspaceRoot) {
  const projectDir = path.join(workspaceRoot, 'projects', 'smoke');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'smoke.fmproj'), 'name: smoke\ndescription: isolated desktop smoke project\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# Wrenyard desktop smoke workspace\n', 'utf8');
}

function readDaemonPid(stateHome) {
  const pidPath = path.join(stateHome, 'wrenyard-daemon.pid');
  try {
    const parsed = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function readDaemonStatePid(stateHome) {
  const statePath = path.join(stateHome, 'wrenyard-daemon.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function parseDaemonPid(output) {
  const match = /pid\s+(\d+)/i.exec(output ?? '');
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function daemonLogTail(stateHome) {
  const logs = [];
  for (const name of ['wrenyard-out.log', 'wrenyard-error.log']) {
    const file = path.join(stateHome, 'logs', name);
    try {
      const text = fs.readFileSync(file, 'utf8').trim().slice(-2000);
      if (text) logs.push(`${name}:\n${text}`);
    } catch {
      // logs appear only after the supervisor creates them
    }
  }
  return logs.join('\n');
}

// ── Wrenyard config (temp, isolated) ─────────────────────────────────────────

function writeWrenyardConfig(configHome, { workspaceRoot, port, ipcPath }) {
  fs.mkdirSync(configHome, { recursive: true });
  const configPath = path.join(configHome, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    service: {
      enabled: true,
      bind: `127.0.0.1:${port}`,
      ipc: { path: ipcPath },
    },
    workspace: { root: workspaceRoot },
    message: { enabled: false },
    messageDelivery: { enabled: false },
  }, null, 2)}\n`, 'utf8');
  return configPath;
}

// ── Repo binaries (default mode) ─────────────────────────────────────────────

function resolveRepoLauncher() {
  const launcher = path.join(ROOT, 'bin', 'wrenyard.mjs');
  if (!fs.existsSync(launcher)) fail(`Wrenyard launcher missing at ${launcher}; run pnpm build first`);
  return launcher;
}

function resolveRepoDesktopDir() {
  const dir = path.join(ROOT, 'apps', 'desktop');
  if (!fs.existsSync(path.join(dir, 'dist', 'main.js'))) {
    fail(`Desktop build output missing at ${dir}/dist; run pnpm build first`);
  }
  return dir;
}

function resolveRepoElectron() {
  const desktopRequire = createRequire(path.join(ROOT, 'apps', 'desktop', 'package.json'));
  try {
    const binary = desktopRequire('electron');
    if (typeof binary === 'string' && fs.existsSync(binary)) return binary;
  } catch {
    // fall through to electron/path.txt
  }
  try {
    const packageDir = path.dirname(desktopRequire.resolve('electron/package.json'));
    const pathTxt = path.join(packageDir, 'path.txt');
    if (fs.existsSync(pathTxt)) {
      const relative = fs.readFileSync(pathTxt, 'utf8').trim();
      const binary = path.join(packageDir, 'dist', relative);
      if (fs.existsSync(binary)) return binary;
    }
    const binary = path.join(packageDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
    return fs.existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

// ── Release directory (--release-dir mode) ───────────────────────────────────

function findFile(dir, re, { matchDirectories = false } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (matchDirectories && (re.test(entry.name) || re.test(p))) return p;
      if (entry.name === 'node_modules' || entry.name.endsWith('.app')) continue;
      const hit = findFile(p, re, { matchDirectories });
      if (hit) return hit;
    } else if (re.test(entry.name) || re.test(p)) {
      return p;
    }
  }
  return null;
}

function extractZip(zipPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === 'win32') {
    run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
    ]);
    return;
  }
  const unzip = spawnSync('unzip', ['-q', zipPath, '-d', destination], { encoding: 'utf8' });
  if (unzip.status === 0) return;
  run('tar', ['-xf', zipPath, '-C', destination]);
}

function verifySidecar(zipPath) {
  const shaPath = `${zipPath}.sha256`;
  if (!fs.existsSync(shaPath)) fail(`checksum sidecar missing for ${zipPath}`);
  const expected = readChecksum(shaPath);
  const actual = sha256File(zipPath);
  if (expected !== actual) fail(`checksum mismatch for ${path.basename(zipPath)}`);
}

function resolveReleaseArtifacts(releaseDir) {
  if (!fs.existsSync(releaseDir) || fs.readdirSync(releaseDir).length === 0) {
    fail(`--release-dir is missing or empty: ${releaseDir}`);
  }
  const triplet = hostTriplet();
  const suiteZip = findFile(releaseDir, new RegExp(`wrenyard-.*-${triplet}-suite\\.zip$`));
  if (!suiteZip) fail(`suite zip for ${triplet} not found in ${releaseDir}`);
  verifySidecar(suiteZip);
  const desktopZip = findFile(releaseDir, new RegExp(`wrenyard-desktop-.*-${triplet}\\.zip$`));
  if (!desktopZip) fail(`desktop zip for ${triplet} not found in ${releaseDir}`);
  verifySidecar(desktopZip);
  return { suiteZip, desktopZip };
}

function resolvePackagedDesktopExecutable(desktopRoot) {
  if (process.platform === 'darwin') {
    const app = findFile(desktopRoot, /啾啾工坊\.app$/u, { matchDirectories: true })
      ?? findFile(desktopRoot, /\.app$/u, { matchDirectories: true });
    if (!app) fail(`packaged Desktop app not found under ${desktopRoot}`);
    const macosDir = path.join(app, 'Contents', 'MacOS');
    const entries = fs.readdirSync(macosDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(macosDir, entry.name));
    const preferred = entries.find((entry) => {
      const name = path.basename(entry);
      return name === '啾啾工坊' || name === 'wrenyard-desktop';
    });
    if (preferred) return preferred;
    if (entries.length > 0) return entries[0];
    fail(`packaged Desktop executable not found under ${macosDir}`);
  }
  const exeName = process.platform === 'win32' ? /^wrenyard-desktop\.exe$/u : /^wrenyard-desktop$/u;
  const exe = findFile(desktopRoot, exeName);
  if (!exe) fail(`packaged Desktop executable not found under ${desktopRoot}`);
  return exe;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tmp = mktempDir('wrenyard-desktop-smoke-');
  const children = [];
  const ownedPids = [];
  const isolation = createIsolation(tmp);
  let launcher = null;
  let configPath = null;
  let suiteRoot = ROOT;
  let daemonEnv = isolation.env;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const child of children.reverse()) {
      await terminateTree(child).catch(() => undefined);
    }
    const leftoverDaemon = readDaemonPid(isolation.stateHome) ?? readDaemonStatePid(isolation.stateHome);
    if (leftoverDaemon) ownedPids.push(leftoverDaemon);
    if (launcher && configPath) {
      runWrenyard(launcher, ['daemon', 'stop', '--config', configPath], {
        cwd: suiteRoot,
        env: daemonEnv,
      });
    }
    for (const pid of ownedPids.splice(0)) {
      await terminatePid(pid).catch(() => undefined);
    }
    if (!options.keep) fs.rmSync(tmp, { recursive: true, force: true });
    else log(`kept temp dir: ${tmp}`);
  };

  const onSignal = () => {
    void cleanup().finally(() => process.exit(1));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const workspaceRoot = path.join(tmp, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    registerWorkspaceProject(workspaceRoot);

    const port = await findFreePort();
    const ipcPath = resolveTempIpcPath('ipc');
    configPath = writeWrenyardConfig(isolation.configHome, { workspaceRoot, port, ipcPath });
    writeManagedProviderAuth(isolation.dataHome, SMOKE_PROVIDER_ID, SMOKE_PROVIDER_KEY);

    let desktopCommand;
    let desktopCwd = ROOT;
    let electronEntry = null;

    if (options.releaseDir) {
      const { suiteZip, desktopZip } = resolveReleaseArtifacts(options.releaseDir);
      const suiteExtract = path.join(tmp, 'suite');
      const desktopExtract = path.join(tmp, 'desktop');
      extractZip(suiteZip, suiteExtract);
      extractZip(desktopZip, desktopExtract);
      log(`extracted ${path.basename(suiteZip)} and ${path.basename(desktopZip)}`);

      const launcherName = process.platform === 'win32' ? 'wrenyard.exe' : 'wrenyard';
      launcher = findFile(suiteExtract, new RegExp(`^${launcherName.replace('.', '\\.')}$`));
      if (!launcher) fail('suite archive is missing the wrenyard launcher');
      if (process.platform !== 'win32') fs.chmodSync(launcher, 0o755);
      suiteRoot = suiteExtract;

      desktopCommand = resolvePackagedDesktopExecutable(desktopExtract);
      desktopCwd = suiteRoot;
    } else {
      launcher = resolveRepoLauncher();
      const desktopDir = resolveRepoDesktopDir();
      const electronBin = resolveRepoElectron();
      if (!electronBin) fail('electron is not installed in apps/desktop; run pnpm install and pnpm build first');
      electronEntry = desktopDir;
      desktopCommand = electronBin;
      desktopCwd = desktopDir;
      suiteRoot = ROOT;
    }

    log(`starting daemon via ${launcher}`);
    daemonEnv = {
      ...isolation.env,
      WRENYARD_IPC_PATH: ipcPath,
      WRENYARD_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      WRENYARD_WORKSPACE: workspaceRoot,
      WRENYARD_DESKTOP_WORKSPACE: workspaceRoot,
      WRENYARD_CLI: launcher,
    };
    if (!options.releaseDir) daemonEnv.WRENYARD_ROOT = ROOT;

    const start = spawnWrenyard(launcher, ['daemon', 'start', '--config', configPath], {
      cwd: suiteRoot,
      env: daemonEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(start);
    let startOut = '';
    start.stdout?.on('data', (chunk) => { startOut += chunk.toString('utf8'); });
    start.stderr?.on('data', (chunk) => { startOut += chunk.toString('utf8'); });

    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`daemon start timed out\n${startOut}\n${daemonLogTail(isolation.stateHome)}`)), DAEMON_START_TIMEOUT_MS);
      start.once('exit', (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve();
        else reject(new Error(`daemon start exited ${code}\n${startOut}\n${daemonLogTail(isolation.stateHome)}`));
      });
      start.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });

    const daemonPid = parseDaemonPid(startOut) ?? readDaemonPid(isolation.stateHome) ?? readDaemonStatePid(isolation.stateHome);
    if (daemonPid) ownedPids.push(daemonPid);

    await waitFor(() => isIpcReachable(ipcPath), DAEMON_START_TIMEOUT_MS, `daemon IPC at ${ipcPath}`);
    log('daemon IPC reachable');

    await ipcRequest(ipcPath, 'provider.configure', { providerId: SMOKE_PROVIDER_ID, key: SMOKE_PROVIDER_KEY });
    const listed = await ipcRequest(ipcPath, 'provider.list');
    const configured = (listed?.providers ?? []).find((provider) => provider.id === SMOKE_PROVIDER_ID);
    if (!configured?.configured) fail(`loopback smoke provider ${SMOKE_PROVIDER_ID} was not marked configured`);
    const connection = await ipcRequest(ipcPath, 'gateway.connection');
    if (!Array.isArray(connection?.models) || connection.models.length === 0) {
      fail('gateway.connection advertised no models after configuring the smoke provider');
    }
    log(`configured provider ${SMOKE_PROVIDER_ID} (${connection.models.length} gateway models)`);

    const userDataDir = path.join(tmp, 'user-data');
    fs.mkdirSync(userDataDir, { recursive: true });
    const desktopEnv = {
      ...daemonEnv,
      WRENYARD_DESKTOP_SMOKE: '1',
    };
    const desktopArgs = electronEntry
      ? [electronEntry, '--smoke', `--user-data-dir=${userDataDir}`]
      : ['--smoke', `--user-data-dir=${userDataDir}`];
    log(`launching Desktop: ${desktopCommand} ${desktopArgs.join(' ')}`);
    const desktop = spawn(desktopCommand, desktopArgs, {
      cwd: desktopCwd,
      env: desktopEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    if (desktop.pid) ownedPids.push(desktop.pid);
    children.push(desktop);
    let desktopOut = '';
    let desktopErr = '';
    desktop.stdout?.on('data', (chunk) => { desktopOut += chunk.toString('utf8'); });
    desktop.stderr?.on('data', (chunk) => { desktopErr += chunk.toString('utf8'); });

    const exitCode = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(`Desktop smoke timed out after ${options.timeoutMs}ms\nstdout:\n${desktopOut}\nstderr:\n${desktopErr}`));
      }, options.timeoutMs);
      desktop.once('exit', (code) => {
        clearTimeout(deadline);
        resolve(code ?? 1);
      });
      desktop.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });

    if (exitCode !== 0) {
      fail(`Desktop smoke exited ${exitCode}\nstdout:\n${desktopOut}\nstderr:\n${desktopErr}`);
    }
    if (!/smoke ok/.test(desktopOut)) {
      fail(`Desktop smoke did not report success\nstdout:\n${desktopOut}\nstderr:\n${desktopErr}`);
    }

    log('stopping daemon');
    runWrenyard(launcher, ['daemon', 'stop', '--config', configPath], {
      cwd: suiteRoot,
      env: daemonEnv,
    });

    log('desktop smoke ok');
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`[desktop-smoke] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
