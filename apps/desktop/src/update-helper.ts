import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface UpdateHelperConfig {
  schema: 'wrenyard.desktop-update-helper.v1';
  platform: 'darwin' | 'win32';
  parentPid: number;
  version: string;
  stagedDesktop: string;
  destinationDesktop: string;
  cliPath: string;
  userDataPath: string;
  resultPath: string;
  cleanupRoots: string[];
}

export interface UpdateHelperDependencies {
  homePath?: string;
  processAlive(pid: number): boolean;
  wait(ms: number): Promise<void>;
  run(command: string, args: string[]): number | null;
  relaunch(appPath: string): void;
}

function validVersion(version: string): boolean {
  return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version);
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

function isSafeCleanupRoot(config: UpdateHelperConfig, root: string): boolean {
  const resolved = resolve(root);
  return (dirname(resolved) === resolve(config.userDataPath) && basename(resolved).startsWith('.wrenyard-update-'))
    || (dirname(resolved) === dirname(resolve(config.destinationDesktop))
      && basename(resolved).startsWith('.wrenyard-desktop-update-'));
}

function assertConfig(config: UpdateHelperConfig, homePath = homedir()): void {
  if (config.schema !== 'wrenyard.desktop-update-helper.v1') throw new Error('invalid helper schema');
  if (config.platform !== 'darwin' && config.platform !== 'win32') throw new Error('invalid helper platform');
  if (!Number.isInteger(config.parentPid) || config.parentPid <= 0) throw new Error('invalid parent pid');
  if (!validVersion(config.version)) throw new Error('invalid update version');
  const destination = resolve(config.destinationDesktop);
  if (config.platform === 'darwin') {
    const expectedDestination = resolve(homePath, 'Applications', '啾啾工坊.app');
    if (destination !== expectedDestination) throw new Error('invalid destination desktop');
  } else if (basename(destination) !== 'Wrenyard Desktop' || basename(dirname(destination)) !== 'Programs') {
    throw new Error('invalid destination desktop');
  }
  const staged = resolve(config.stagedDesktop);
  if (dirname(dirname(staged)) !== dirname(destination)
    || !basename(dirname(staged)).startsWith('.wrenyard-desktop-update-')) {
    throw new Error('invalid staged desktop');
  }
  if (!existsSync(staged)) throw new Error('staged app missing');
  if (!isAbsolute(config.userDataPath) || basename(config.resultPath) !== 'update-result.json'
    || !isWithin(config.userDataPath, config.resultPath)) {
    throw new Error('invalid result path');
  }
  if (!Array.isArray(config.cleanupRoots) || config.cleanupRoots.length !== 2
    || config.cleanupRoots.some((root) => !isSafeCleanupRoot(config, root))) {
    throw new Error('invalid cleanup roots');
  }
}

function writeResult(path: string, status: 'success' | 'failed', version: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ status, version, completedAt: Date.now() })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export async function applyPreparedUpdate(
  config: UpdateHelperConfig,
  dependencies: UpdateHelperDependencies,
): Promise<boolean> {
  assertConfig(config, dependencies.homePath);
  for (let attempt = 0; attempt < 300 && dependencies.processAlive(config.parentPid); attempt += 1) {
    await dependencies.wait(200);
  }
  if (dependencies.processAlive(config.parentPid)) {
    try { writeResult(config.resultPath, 'failed', config.version); } catch { /* parent remains active */ }
    for (const root of config.cleanupRoots) rmSync(root, { recursive: true, force: true });
    return false;
  }

  const backupApp = join(dirname(config.destinationDesktop), `.wrenyard-desktop-previous-${process.pid}`);
  const hadPrevious = existsSync(config.destinationDesktop);
  let replacementActive = false;
  let suiteUpdated = false;
  try {
    rmSync(backupApp, { recursive: true, force: true });
    if (hadPrevious) renameSync(config.destinationDesktop, backupApp);
    renameSync(config.stagedDesktop, config.destinationDesktop);
    replacementActive = true;
    if (config.platform === 'darwin') {
      if (dependencies.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', config.destinationDesktop]) !== 0) {
        throw new Error('installed desktop signature invalid');
      }
    } else {
      const executable = join(config.destinationDesktop, 'wrenyard-desktop.exe');
      if (!existsSync(executable) || statSync(executable).size <= 0) throw new Error('installed desktop executable invalid');
    }
    if (dependencies.run(config.cliPath, ['update', '--version', config.version, '--suite-only', '--json']) !== 0) {
      throw new Error('suite update failed');
    }
    suiteUpdated = true;
    try { rmSync(backupApp, { recursive: true, force: true }); } catch { /* committed update remains valid */ }
    try { writeResult(config.resultPath, 'success', config.version); } catch { /* next automatic check reconciles state */ }
    return true;
  } catch {
    if (!suiteUpdated) {
      if (replacementActive) rmSync(config.destinationDesktop, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (hadPrevious && existsSync(backupApp)) renameSync(backupApp, config.destinationDesktop);
      try { writeResult(config.resultPath, 'failed', config.version); } catch { /* relaunch still wins */ }
    }
    return false;
  } finally {
    for (const root of config.cleanupRoots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    try { dependencies.relaunch(config.destinationDesktop); } catch { /* installation result remains durable */ }
  }
}

export async function runUpdateHelper(configPath: string): Promise<number> {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as UpdateHelperConfig;
  if (config.platform !== process.platform) throw new Error('helper platform mismatch');
  const ok = await applyPreparedUpdate(config, {
    processAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    wait: (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
    run(command, args) {
      return spawnSync(command, args, { shell: false, stdio: 'ignore', env: process.env, windowsHide: true }).status;
    },
    relaunch(desktopPath) {
      const command = config.platform === 'darwin'
        ? '/usr/bin/open'
        : join(desktopPath, 'wrenyard-desktop.exe');
      const args = config.platform === 'darwin' ? [desktopPath] : [];
      const child = spawn(command, args, { shell: false, stdio: 'ignore', detached: true, windowsHide: false });
      child.unref();
    },
  });
  return ok ? 0 : 1;
}
