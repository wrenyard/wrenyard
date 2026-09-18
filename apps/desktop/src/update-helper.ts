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
import {
  readUpdateAttempt,
  sanitizeUpdateAttemptDetail,
  writeUpdateAttempt,
  UPDATE_ATTEMPT_SCHEMA,
  type UpdateAttemptPhase,
  type UpdateAttemptRecovery,
  type UpdateAttemptStatus,
} from './update-attempt.js';

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

/**
 * Native command outcome. A bare exit status stays accepted so a caller that
 * cannot observe stderr keeps working; stderr is what turns "exit 1" into an
 * actionable diagnosis for the suite upgrade.
 */
export interface UpdateHelperCommandResult {
  status: number | null;
  stderr?: string;
}

export interface UpdateHelperDependencies {
  homePath?: string;
  processAlive(pid: number): boolean;
  wait(ms: number): Promise<void>;
  run(command: string, args: string[]): number | null | UpdateHelperCommandResult;
  relaunch(appPath: string): void;
}

function runCommand(
  dependencies: UpdateHelperDependencies,
  command: string,
  args: string[],
): UpdateHelperCommandResult {
  const outcome = dependencies.run(command, args);
  return outcome === null || typeof outcome === 'number' ? { status: outcome } : outcome;
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

function writeResult(path: string, status: 'success' | 'failed', version: string, message?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    status,
    version,
    completedAt: Date.now(),
    ...(message ? { message } : {}),
  })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/**
 * Diagnostic location, derived from the already-declared result path so the
 * helper needs no extra configuration. Only a result path that is still a
 * plausible `update-result.json` inside an absolute userData directory is
 * accepted, so an unvalidated config can never redirect the write.
 */
function attemptRoot(config: UpdateHelperConfig): string | undefined {
  const { resultPath, userDataPath } = config;
  if (typeof resultPath !== 'string' || typeof userDataPath !== 'string') return undefined;
  if (!isAbsolute(userDataPath) || basename(resultPath) !== 'update-result.json') return undefined;
  if (!isWithin(userDataPath, resultPath)) return undefined;
  return dirname(resultPath);
}

function attemptDetail(error: unknown, stderr?: string): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return sanitizeUpdateAttemptDetail([message, stderr].filter((part) => part).join(' | '));
}

/**
 * Update the single durable attempt record. The started time, source and target
 * versions come from the record the controller wrote when the attempt began, so
 * a helper-side outcome extends that attempt instead of starting a new one.
 * Diagnostics never fail the install: every error here is swallowed.
 */
function recordHelperAttempt(config: UpdateHelperConfig, outcome: {
  status: UpdateAttemptStatus;
  phase: UpdateAttemptPhase;
  error?: string;
  exitCode?: number | null;
  recovery?: UpdateAttemptRecovery;
}): void {
  const root = attemptRoot(config);
  if (root === undefined) return;
  try {
    const previous = readUpdateAttempt(root);
    const version = typeof config.version === 'string' && validVersion(config.version)
      ? config.version
      : 'unknown';
    writeUpdateAttempt(root, {
      schema: UPDATE_ATTEMPT_SCHEMA,
      sourceVersion: previous?.sourceVersion ?? 'unknown',
      targetVersion: previous?.targetVersion ?? version,
      startedAt: previous?.startedAt ?? Date.now(),
      completedAt: Date.now(),
      status: outcome.status,
      phase: outcome.phase,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.recovery !== undefined ? { recovery: outcome.recovery } : {}),
    });
  } catch { /* diagnostics never block the install path */ }
}

export async function applyPreparedUpdate(
  config: UpdateHelperConfig,
  dependencies: UpdateHelperDependencies,
): Promise<boolean> {
  try {
    assertConfig(config, dependencies.homePath);
  } catch (error) {
    // A rejected config never touches the installed app, but the reason is the
    // only trace of why the update stopped, so keep it when it is safe to.
    recordHelperAttempt(config, { status: 'failed', phase: 'prepare', error: attemptDetail(error) });
    throw error;
  }
  for (let attempt = 0; attempt < 300 && dependencies.processAlive(config.parentPid); attempt += 1) {
    await dependencies.wait(200);
  }
  if (dependencies.processAlive(config.parentPid)) {
    try {
      writeResult(config.resultPath, 'failed', config.version, '等待 Desktop 退出超时');
    } catch { /* parent remains active */ }
    recordHelperAttempt(config, {
      status: 'failed',
      phase: 'parent-wait',
      error: 'timed out waiting for Desktop to exit',
      recovery: 'cleanup-only',
    });
    for (const root of config.cleanupRoots) rmSync(root, { recursive: true, force: true });
    return false;
  }

  const backupApp = join(dirname(config.destinationDesktop), `.wrenyard-desktop-previous-${process.pid}`);
  const hadPrevious = existsSync(config.destinationDesktop);
  let replacementActive = false;
  let suiteUpdated = false;
  let failureMessage = '准备 Desktop 更新失败';
  let failurePhase: UpdateAttemptPhase = 'prepare';
  let failureExitCode: number | null | undefined;
  let failureStderr: string | undefined;
  try {
    failureMessage = '清理旧 Desktop 备份失败';
    failurePhase = 'backup';
    rmSync(backupApp, { recursive: true, force: true });
    if (hadPrevious) {
      failureMessage = '备份当前 Desktop 失败';
      renameSync(config.destinationDesktop, backupApp);
    }
    failureMessage = '启用新版 Desktop 失败';
    failurePhase = 'swap';
    renameSync(config.stagedDesktop, config.destinationDesktop);
    replacementActive = true;
    failurePhase = 'verify';
    if (config.platform === 'darwin') {
      failureMessage = '新版 Desktop 签名验证失败';
      const signature = runCommand(dependencies, '/usr/bin/codesign', ['--verify', '--deep', '--strict', config.destinationDesktop]);
      if (signature.status !== 0) {
        failureMessage = `新版 Desktop 签名验证失败（退出码 ${signature.status ?? 'unknown'}）`;
        failureExitCode = signature.status;
        failureStderr = signature.stderr;
        throw new Error('installed desktop signature invalid');
      }
    } else {
      const executable = join(config.destinationDesktop, 'wrenyard-desktop.exe');
      if (!existsSync(executable) || statSync(executable).size <= 0) {
        failureMessage = '新版 Desktop 可执行文件验证失败';
        throw new Error('installed desktop executable invalid');
      }
    }
    failureMessage = 'Daemon 套件升级失败';
    failurePhase = 'suite-update';
    const suite = runCommand(dependencies, config.cliPath, ['update', '--version', config.version, '--suite-only', '--json']);
    if (suite.status !== 0) {
      failureMessage = `Daemon 套件升级失败（退出码 ${suite.status ?? 'unknown'}）`;
      failureExitCode = suite.status;
      failureStderr = suite.stderr;
      throw new Error('suite update failed');
    }
    suiteUpdated = true;
    try { rmSync(backupApp, { recursive: true, force: true }); } catch { /* committed update remains valid */ }
    try { writeResult(config.resultPath, 'success', config.version); } catch { /* next automatic check reconciles state */ }
    recordHelperAttempt(config, { status: 'succeeded', phase: 'relaunch', exitCode: 0, recovery: 'none' });
    return true;
  } catch (error) {
    let recoveryMessage = '';
    let recovery: UpdateAttemptRecovery = suiteUpdated ? 'none' : 'cleanup-only';
    if (!suiteUpdated) {
      try {
        if (replacementActive) rmSync(config.destinationDesktop, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (hadPrevious && existsSync(backupApp)) {
          renameSync(backupApp, config.destinationDesktop);
          recoveryMessage = '；已恢复原 Desktop';
          recovery = 'restored-previous';
        } else if (replacementActive) {
          recoveryMessage = '；已移除未完成的 Desktop';
          recovery = 'removed-incomplete';
        }
      } catch {
        recoveryMessage = '；恢复原 Desktop 失败';
        recovery = 'restore-failed';
      }
      try {
        writeResult(config.resultPath, 'failed', config.version, `${failureMessage}${recoveryMessage}`);
      } catch { /* relaunch still wins */ }
    }
    // Recorded before cleanup so the diagnosis exists even if cleanup or the
    // relaunch below goes wrong; the record itself lives outside every root.
    recordHelperAttempt(config, {
      status: 'failed',
      phase: failurePhase,
      error: attemptDetail(error, failureStderr),
      ...(failureExitCode !== undefined ? { exitCode: failureExitCode } : {}),
      recovery,
    });
    return false;
  } finally {
    for (const root of config.cleanupRoots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    try {
      dependencies.relaunch(config.destinationDesktop);
    } catch (error) {
      // A committed update that cannot restart Desktop has no other trace; a
      // failed attempt already recorded a more precise phase, so keep that.
      if (suiteUpdated) {
        recordHelperAttempt(config, {
          status: 'succeeded',
          phase: 'relaunch',
          error: attemptDetail(error),
        });
      }
    }
  }
}

export async function runUpdateHelper(configPath: string): Promise<number> {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as UpdateHelperConfig;
  if (config.platform !== process.platform) {
    recordHelperAttempt(config, {
      status: 'failed',
      phase: 'prepare',
      error: 'helper platform mismatch',
    });
    throw new Error('helper platform mismatch');
  }
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
      // stderr is piped instead of ignored: it carries the native cause of a
      // failed suite upgrade, which an exit code alone cannot explain.
      const result = spawnSync(command, args, {
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        env: process.env,
        windowsHide: true,
      });
      const stderr = typeof result.stderr === 'string' ? result.stderr.slice(-4 * 1024) : '';
      return { status: result.status, ...(stderr ? { stderr } : {}) };
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
