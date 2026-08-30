import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface UpdateHelperConfig {
  schema: 'wrenyard.desktop-update-helper.v1';
  parentPid: number;
  version: string;
  stagedApp: string;
  destinationApp: string;
  cliPath: string;
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

function isSafeCleanupRoot(homePath: string, root: string): boolean {
  const resolved = resolve(root);
  const updateRoot = resolve(homePath, '.wrenyard-updates');
  const applications = resolve(homePath, 'Applications');
  return (dirname(resolved) === updateRoot && basename(resolved).startsWith('desktop-'))
    || (dirname(resolved) === applications && basename(resolved).startsWith('.wrenyard-desktop-update-'));
}

function assertConfig(config: UpdateHelperConfig, homePath = homedir()): void {
  const applications = resolve(homePath, 'Applications');
  const expectedDestination = join(applications, '啾啾工坊.app');
  if (config.schema !== 'wrenyard.desktop-update-helper.v1') throw new Error('invalid helper schema');
  if (!Number.isInteger(config.parentPid) || config.parentPid <= 0) throw new Error('invalid parent pid');
  if (!validVersion(config.version)) throw new Error('invalid update version');
  if (resolve(config.destinationApp) !== resolve(expectedDestination)) throw new Error('invalid destination app');
  const staged = resolve(config.stagedApp);
  if (dirname(dirname(staged)) !== applications || !dirname(staged).startsWith(join(applications, '.wrenyard-desktop-update-'))) {
    throw new Error('invalid staged app');
  }
  if (!existsSync(staged)) throw new Error('staged app missing');
  const resultRoot = resolve(homePath, 'Library', 'Application Support');
  if (basename(config.resultPath) !== 'update-result.json' || !isWithin(resultRoot, config.resultPath)) {
    throw new Error('invalid result path');
  }
  if (!Array.isArray(config.cleanupRoots) || config.cleanupRoots.length !== 2
    || config.cleanupRoots.some((root) => !isSafeCleanupRoot(homePath, root))) {
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

  const backupApp = join(dirname(config.destinationApp), `.wrenyard-desktop-previous-${process.pid}.app`);
  const hadPrevious = existsSync(config.destinationApp);
  let replacementActive = false;
  let suiteUpdated = false;
  try {
    rmSync(backupApp, { recursive: true, force: true });
    if (hadPrevious) renameSync(config.destinationApp, backupApp);
    renameSync(config.stagedApp, config.destinationApp);
    replacementActive = true;
    if (dependencies.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', config.destinationApp]) !== 0) {
      throw new Error('installed desktop signature invalid');
    }
    if (dependencies.run(config.cliPath, ['update', '--version', config.version, '--json']) !== 0) {
      throw new Error('suite update failed');
    }
    suiteUpdated = true;
    try { rmSync(backupApp, { recursive: true, force: true }); } catch { /* committed update remains valid */ }
    try { writeResult(config.resultPath, 'success', config.version); } catch { /* next automatic check reconciles state */ }
    return true;
  } catch {
    if (!suiteUpdated) {
      if (replacementActive) rmSync(config.destinationApp, { recursive: true, force: true });
      if (hadPrevious && existsSync(backupApp)) renameSync(backupApp, config.destinationApp);
      try { writeResult(config.resultPath, 'failed', config.version); } catch { /* relaunch still wins */ }
    }
    return false;
  } finally {
    for (const root of config.cleanupRoots) rmSync(root, { recursive: true, force: true });
    try { dependencies.relaunch(config.destinationApp); } catch { /* installation result remains durable */ }
  }
}

export async function runUpdateHelper(configPath: string): Promise<number> {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as UpdateHelperConfig;
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
      return spawnSync(command, args, { shell: false, stdio: 'ignore', env: process.env }).status;
    },
    relaunch(appPath) {
      spawnSync('/usr/bin/open', [appPath], { shell: false, stdio: 'ignore' });
    },
  });
  return ok ? 0 : 1;
}
