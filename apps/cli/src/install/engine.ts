/** The SEA install/update engine (spec section 5). */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { foremanStateRoot } from '@wrenyard/daemon/config/state';
import {
  channelForVersion,
  normalizeVersion,
  parseUpdateFeedJson,
  resolveUpdateBaseUrl,
  suiteAssetName,
  desktopAssetName,
  updateDocumentUrl,
} from '@wrenyard/protocol/update-feed';
import type { PlatformTriplet } from '@wrenyard/protocol/update-feed';
import { readSourceDevLock, sourceDevLockRefusalMessage } from '../source-dev-lock.mjs';
import {
  DESKTOP_APP_NAME,
  DESKTOP_WINDOWS_EXE,
  CURRENT_LINK,
  MACOS_LSREGISTER,
  desktopAppDir,
  desktopAppExe,
  desktopParentDir,
  desktopProbeIsRunning,
  desktopRunningProbe,
  defaultBinDir,
  defaultPrefix,
  isWindows,
  launcherFileName,
  platformTriplet,
  startMenuShortcutPath,
  suiteExecutableName,
} from './platform.js';
import type { CommandResult, CommandRunner } from './platform.js';
import {
  InstallLockHeldError,
  acquireInstallLock,
  appendUpdateLog,
  cleanupVersions,
  clearInstallState,
  createLauncher,
  isProcessAlive,
  makeExecutable,
  readCurrent,
  readDesktopVersion,
  readSuiteVersion,
  realTarget,
  recoverInterrupted,
  removeLink,
  removePath,
  renameWithRetry,
  sameRealTarget,
  sleep,
  switchCurrent,
  versionDir,
  writeDesktopVersion,
  writeInstallState,
  writeResultFile,
} from './filesystem.js';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  downloadFile,
  extractZip,
  isNonEmptyFile,
  readSidecarDigest,
  sha256File,
  verifyCodesign,
} from './download.js';
import type { FetchLike } from './download.js';

/** Result of a bridged control-tree CLI invocation. */
export interface ControlResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Bridges daemon stop/status through the current suite's control tree. */
export type ControlBridge = (args: string[]) => Promise<ControlResult>;

/** Engine mode: a fresh/repeat install, or an update from an installed suite. */
export type EngineMode = 'install' | 'update';

export interface InstallEngineOptions {
  mode: EngineMode;
  version?: string;
  suiteZip?: string;
  artifactsDir?: string;
  prefix?: string;
  binDir?: string;
  noDesktop?: boolean;
  waitPid?: number;
  relaunchDesktop?: boolean;
  resultFile?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  execPath?: string;
  runner?: CommandRunner;
  fetchImpl?: FetchLike;
  control?: ControlBridge;
  now?: () => number;
  pid?: number;
  log?: (line: string) => void;
  idleTimeoutMs?: number;
  desktopWaitTimeoutMs?: number;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  installSignalHandlers?: boolean;
}

export interface EngineOutcome {
  status: 'ok' | 'up-to-date' | 'failed';
  ok: boolean;
  upToDate: boolean;
  from?: string;
  to?: string;
  rolledBack: boolean;
  message?: string;
}

const RUN_OPTIONS: SpawnSyncOptions = { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
const DEFAULT_DESKTOP_WAIT_MS = 60_000;
const DEFAULT_HEALTH_MS = 60_000;
const DEFAULT_POLL_MS = 500;

/** Run a control-tree child asynchronously, capturing its output without blocking. */
export function runControl(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ControlResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error: error as Error });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (code: number | null) => resolve({ status: code, stdout, stderr }));
  });
}

function defaultRunner(): CommandRunner {
  return (command, args, options) => {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      ...RUN_OPTIONS,
      env: options.env,
      cwd: options.cwd,
    });
    return {
      status: result.status,
      error: result.error,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  };
}

function succeed(to: string, from?: string): EngineOutcome {
  return { status: 'ok', ok: true, upToDate: false, from, to, rolledBack: false };
}

function upToDate(to: string, from?: string): EngineOutcome {
  return {
    status: 'up-to-date',
    ok: true,
    upToDate: true,
    from,
    to,
    rolledBack: false,
    message: `already at ${to}`,
  };
}

function failure(message: string, rolledBack = false, from?: string, to?: string): EngineOutcome {
  return { status: 'failed', ok: false, upToDate: false, from, to, rolledBack, message };
}

/** Derive the install prefix from `<prefix>/versions/<v>` as the running exe. */
export function prefixFromExecPath(execPath: string): string | null {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return null;
  }
  const versionDirPath = dirname(real);
  const versionsDir = dirname(versionDirPath);
  if (basename(versionsDir) !== 'versions') return null;
  return dirname(versionsDir);
}

interface AssetRef {
  name: string;
  url?: string;
  path?: string;
  sha256: string;
}

interface ResolvedTarget {
  version: string;
  suite: AssetRef;
  desktop: AssetRef | null;
}

function parseSuiteAssetVersion(name: string, triplet: PlatformTriplet): string | null {
  const match = /^wrenyard-(.+)-([a-z0-9]+-[a-z0-9]+)-suite\.zip$/.exec(name);
  if (match === null || match[2] !== triplet) return null;
  return match[1] ?? null;
}

async function resolveFeedTarget(
  options: InstallEngineOptions,
  env: NodeJS.ProcessEnv,
  triplet: PlatformTriplet,
  currentVersion: string | undefined,
  fetchImpl: FetchLike,
): Promise<ResolvedTarget> {
  const base = resolveUpdateBaseUrl(env);
  const expected = options.version !== undefined ? normalizeVersion(options.version) : undefined;
  const channel =
    expected === undefined && currentVersion !== undefined
      ? channelForVersion(currentVersion)
      : 'dev';
  const url = updateDocumentUrl(base, expected === undefined ? { channel } : { version: expected });
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`update feed request failed: HTTP ${response.status} for ${url}`);
  const text = await response.text();
  const parsed = parseUpdateFeedJson(text, { triplet, expectedVersion: expected });
  return {
    version: parsed.version,
    suite: { name: parsed.suite.name, url: parsed.suite.url, sha256: parsed.suite.sha256 },
    desktop: { name: parsed.desktop.name, url: parsed.desktop.url, sha256: parsed.desktop.sha256 },
  };
}

function resolveArtifactsTarget(
  options: InstallEngineOptions,
  triplet: PlatformTriplet,
): ResolvedTarget {
  const dir = options.artifactsDir as string;
  let version = options.version !== undefined ? normalizeVersion(options.version) : undefined;
  if (version === undefined) {
    for (const entry of readdirSync(dir)) {
      const found = parseSuiteAssetVersion(entry, triplet);
      if (found !== null) {
        version = found;
        break;
      }
    }
  }
  if (version === undefined) {
    throw new Error(`no ${triplet} suite zip found in ${dir}`);
  }
  const suiteName = suiteAssetName(version, triplet);
  const suitePath = join(dir, suiteName);
  if (!existsSync(suitePath)) throw new Error(`missing suite archive: ${suitePath}`);
  const desktopName = desktopAssetName(version, triplet);
  const desktopPath = join(dir, desktopName);
  return {
    version,
    suite: { name: suiteName, path: suitePath, sha256: readSidecarDigest(suitePath) },
    desktop: existsSync(desktopPath)
      ? { name: desktopName, path: desktopPath, sha256: readSidecarDigest(desktopPath) }
      : null,
  };
}

interface DaemonStatus {
  ok: boolean;
  running: boolean;
  shuttingDown: boolean;
  suiteRoot: string | null;
  ipcOk: boolean | null;
}

/** Normalize a `service status --json` payload, or null when it is not an object. */
function parseDaemonStatus(text: string): DaemonStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  const daemon =
    payload.daemon !== null && typeof payload.daemon === 'object' && !Array.isArray(payload.daemon)
      ? (payload.daemon as Record<string, unknown>)
      : {};
  const ipc =
    payload.ipc !== null && typeof payload.ipc === 'object' && !Array.isArray(payload.ipc)
      ? (payload.ipc as Record<string, unknown>)
      : daemon.ipc !== null && typeof daemon.ipc === 'object' && !Array.isArray(daemon.ipc)
        ? (daemon.ipc as Record<string, unknown>)
        : null;
  const suiteRoot = daemon.suiteRoot;
  return {
    ok: payload.ok === true,
    running: daemon.running === true,
    shuttingDown: payload.shutting_down === true || daemon.shutting_down === true,
    suiteRoot: typeof suiteRoot === 'string' && suiteRoot.length > 0 ? suiteRoot : null,
    ipcOk: ipc !== null && typeof ipc.ok === 'boolean' ? ipc.ok : null,
  };
}

/** A daemon is healthy when it reports ok, is running with reachable IPC and serves `wanted`. */
function daemonHealthyFor(status: DaemonStatus, wanted: string | null, platform: NodeJS.Platform): boolean {
  if (!status.ok || !status.running || status.shuttingDown) return false;
  if (status.ipcOk === false) return false;
  if (status.suiteRoot === null) return false;
  if (wanted === null) return true;
  const resolvedRoot = realTarget(status.suiteRoot);
  return resolvedRoot !== null && sameRealTarget(resolvedRoot, wanted, platform);
}

/** Env for launcher spawns: drop stale suite-pinned root and node binary. */
function launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped = { ...env };
  delete stripped.WRENYARD_ROOT;
  delete stripped.WRENYARD_NODE_BIN;
  return stripped;
}

async function desktopIsRunning(
  runner: CommandRunner,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const probe = desktopRunningProbe(platform);
  const result = await runner(probe.command, probe.args, { env });
  return desktopProbeIsRunning(platform, {
    status: result.status,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function stagedDesktopApp(staging: string, platform: NodeJS.Platform): string {
  if (isWindows(platform)) return staging;
  const bundle = join(staging, DESKTOP_APP_NAME);
  return existsSync(bundle) ? bundle : staging;
}

async function validateSuite(
  staging: string,
  version: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<void> {
  const exe = join(staging, suiteExecutableName(platform));
  makeExecutable(exe);
  const nodeName = isWindows(platform) ? 'node.exe' : 'node';
  makeExecutable(join(staging, 'runtime', nodeName));
  const stamped = readSuiteVersion(staging);
  if (stamped !== version) {
    throw new Error(`staged suite SUITE_VERSION is ${stamped ?? 'missing'}, expected ${version}`);
  }
  await verifyCodesign(exe, env, platform, runner, false);
  const result = await runner(exe, ['--version'], { env });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`staged suite failed to run: ${result.error?.message ?? result.stderr.trim()}`);
  }
  if (!result.stdout.includes(version)) {
    throw new Error(`staged suite reports an unexpected version: ${result.stdout.trim()}`);
  }
}

async function validateDesktop(
  appPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<void> {
  if (isWindows(platform)) {
    if (!isNonEmptyFile(join(appPath, DESKTOP_WINDOWS_EXE))) {
      throw new Error(`staged Desktop is missing ${DESKTOP_WINDOWS_EXE}`);
    }
    return;
  }
  await verifyCodesign(appPath, env, platform, runner, true);
}

/** Windows Start Menu shortcut via PowerShell 5.1 WScript.Shell, EncodedCommand. */
async function createWindowsShortcut(
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
  exePath: string,
): Promise<CommandResult> {
  const shortcut = startMenuShortcutPath(env);
  const script =
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${shortcut.replace(/'/g, "''")}'); ` +
    `$s.TargetPath = '${exePath.replace(/'/g, "''")}'; ` +
    `$s.WorkingDirectory = '${dirname(exePath).replace(/'/g, "''")}'; $s.Save()`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runner('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { env });
}

async function defaultRelaunch(
  target: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<void> {
  if (isWindows(platform)) {
    const child = spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: true, env });
    // A detached spawn reports failure asynchronously; swallow it so a bad
    // relaunch can never surface as an unhandled 'error' event.
    child.on('error', () => {});
    child.unref();
    return;
  }
  await runner('/usr/bin/open', [target], { env });
}

/** Run one install or update transaction; returns an outcome rather than throwing. */
export async function runInstallEngine(options: InstallEngineOptions): Promise<EngineOutcome> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => Date.now());
  const runner = options.runner ?? defaultRunner();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;

  const logDir = join(foremanStateRoot(env), 'logs');
  const emit = (line: string): void => {
    appendUpdateLog(logDir, line);
    if (options.log !== undefined) options.log(line);
    else process.stdout.write(`${line}\n`);
  };

  const desktopTarget = desktopAppDir(env, platform);
  const desktopParent = desktopParentDir(env, platform);
  // Step 13 relaunches the Desktop executable: spawning the app directory fails on Windows.
  const relaunchTarget = isWindows(platform) ? desktopAppExe(env, platform) : desktopTarget;

  const relaunchDesktopIfRequested = async (): Promise<void> => {
    if (options.relaunchDesktop !== true) return;
    try {
      await defaultRelaunch(relaunchTarget, platform, env, runner);
    } catch (error) {
      // Preserve the primary error: a failed relaunch is logged, not surfaced.
      emit(`relaunching the Desktop failed: ${(error as Error).message}`);
    }
  };

  /** Record a failed result file and relaunch the Desktop on any terminal outcome. */
  const finishFailure = async (outcome: EngineOutcome): Promise<EngineOutcome> => {
    if (options.resultFile !== undefined) {
      try {
        writeResultFile(options.resultFile, {
          status: 'failed',
          from: outcome.from,
          to: outcome.to,
          message: outcome.message,
          rolled_back: outcome.rolledBack,
        });
      } catch {
        // A failed result-file write must never replace the primary error.
      }
    }
    await relaunchDesktopIfRequested();
    return outcome;
  };

  const triplet = platformTriplet(platform, arch);
  if (triplet === null) {
    return finishFailure(failure(`unsupported platform: ${platform}-${arch}`));
  }

  const execPath = options.execPath ?? process.execPath;
  let prefix: string | undefined;
  if (options.prefix !== undefined && options.prefix.length > 0) {
    prefix = options.prefix;
  } else if (typeof env.WRENYARD_PREFIX === 'string' && env.WRENYARD_PREFIX.length > 0) {
    prefix = env.WRENYARD_PREFIX;
  } else if (options.mode === 'update') {
    const derived = prefixFromExecPath(execPath);
    if (derived === null) {
      return finishFailure(
        failure('cannot determine the install prefix from the running executable; set WRENYARD_PREFIX'),
      );
    }
    prefix = derived;
  } else {
    prefix = defaultPrefix(env, platform);
  }
  const binDir =
    options.binDir ?? (typeof env.WRENYARD_BIN_DIR === 'string' && env.WRENYARD_BIN_DIR.length > 0
      ? env.WRENYARD_BIN_DIR
      : defaultBinDir(prefix, env, platform));

  const runningDir = realTarget(dirname(execPath));
  const launcher = join(prefix, 'current', suiteExecutableName(platform));

  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = acquireInstallLock(prefix, pid, now);
  } catch (error) {
    if (error instanceof InstallLockHeldError) return finishFailure(failure(error.message));
    throw error;
  }

  // Transaction state shared with the rollback path.
  const tx: {
    fromVersion?: string;
    toVersion?: string;
    previousCurrent: string | null;
    placedSuite: boolean;
    oldSuiteDir: string | null;
    desktopBackup: string | null;
    desktopReplaced: boolean;
    switchedCurrent: boolean;
    createdLauncher: boolean;
    wasRunning: boolean;
    stateWritten: boolean;
    committed: boolean;
    rolledBack: boolean;
  } = {
    previousCurrent: null,
    placedSuite: false,
    oldSuiteDir: null,
    desktopBackup: null,
    desktopReplaced: false,
    switchedCurrent: false,
    createdLauncher: false,
    wasRunning: false,
    stateWritten: false,
    committed: false,
    rolledBack: false,
  };

  const rollback = async (): Promise<boolean> => {
    if (tx.rolledBack || tx.committed) return true;
    let ok = true;
    const step = async (label: string, action: () => Promise<void> | void): Promise<void> => {
      try {
        await action();
      } catch (error) {
        ok = false;
        emit(`rollback: ${label} failed: ${(error as Error).message}`);
      }
    };
    if (tx.previousCurrent !== null) {
      const target = resolve(prefix as string, tx.previousCurrent);
      if (existsSync(target)) {
        await step('restore current', () => switchCurrent(prefix as string, target, platform, pid));
      }
    } else if (tx.switchedCurrent) {
      // Fresh install: there is no previous version to restore, so remove the
      // new `current` link instead of leaving it dangling at the new suite.
      await step('remove current', () => {
        removeLink(join(prefix as string, CURRENT_LINK), platform);
      });
    }
    if (tx.createdLauncher) {
      await step('remove launcher', () => {
        removePath(join(binDir, launcherFileName(platform)), emit);
      });
    }
    if (tx.desktopBackup !== null) {
      await step('restore Desktop', async () => {
        if (existsSync(desktopTarget)) removePath(desktopTarget, emit);
        if (existsSync(tx.desktopBackup as string)) {
          await renameWithRetry(tx.desktopBackup as string, desktopTarget);
        }
      });
    } else if (tx.desktopReplaced) {
      // Fresh install: no previous bundle existed, so remove the newly placed
      // Desktop rather than leave it behind on a failed first install.
      await step('remove Desktop', () => {
        removePath(desktopTarget, emit);
      });
    }
    if (tx.toVersion !== undefined && (tx.placedSuite || tx.oldSuiteDir !== null)) {
      await step('restore suite', async () => {
        const newDir = versionDir(prefix as string, tx.toVersion as string);
        if (tx.oldSuiteDir !== null) {
          if (existsSync(tx.oldSuiteDir)) {
            removePath(newDir, emit);
            await renameWithRetry(tx.oldSuiteDir, newDir);
          }
        } else if (tx.placedSuite) {
          removePath(newDir, emit);
        }
      });
    }
    if (tx.wasRunning && options.control !== undefined) {
      await step('restart previous daemon', async () => {
        const previousDir =
          tx.previousCurrent !== null ? resolve(prefix as string, tx.previousCurrent) : null;
        // Start the restored suite's own executable, not the freshly switched launcher.
        const restartExe =
          previousDir !== null ? join(previousDir, suiteExecutableName(platform)) : launcher;
        const started = await runner(restartExe, ['daemon', 'start'], { env: launchEnv(env) });
        if (started.error !== undefined || started.status !== 0) {
          throw new Error(
            `failed to restart the previous daemon: ${started.error?.message ?? started.stderr.trim()}`,
          );
        }
      });
    }
    tx.rolledBack = true;
    if (ok) {
      // Only remove a journal this run actually wrote: a journal retained by a
      // failed step-0 repair must survive so the next run can finish it.
      if (tx.stateWritten) clearInstallState(prefix as string);
      emit('rolled back to the previous version');
    } else {
      emit('rollback incomplete; install-state.json kept for the next run to finish recovery');
    }
    return ok;
  };

  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
  };
  const checkInterrupted = (): void => {
    if (interrupted) throw new Error('interrupted by a termination signal');
  };
  if (options.installSignalHandlers !== false) {
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);
    if (platform === 'win32') process.on('SIGBREAK', onInterrupt);
  }

  try {
    // Step 0: repair any interrupted previous run.
    await recoverInterrupted(prefix, platform, emit, pid, desktopTarget, runningDir);
    checkInterrupted();

    // Step 1: prechecks that must refuse before touching the system.
    const devLock = readSourceDevLock(env);
    if (devLock !== undefined) return finishFailure(failure(sourceDevLockRefusalMessage(devLock)));
    if (typeof env.FOREMAN_TASK_RUN_ID === 'string' && env.FOREMAN_TASK_RUN_ID.length > 0) {
      return finishFailure(
        failure(
          'cannot run install/update inside a Task: the engine waits for the daemon to drain, and draining waits for this Task to finish',
        ),
      );
    }

    // Step 2: resolve the target version and assets.
    tx.previousCurrent = readCurrent(prefix);
    const currentVersionDir =
      tx.previousCurrent !== null ? resolve(prefix, tx.previousCurrent) : null;
    const currentVersion =
      currentVersionDir !== null ? (readSuiteVersion(currentVersionDir) ?? undefined) : undefined;
    tx.fromVersion = currentVersion;

    let resolved: ResolvedTarget;
    try {
      if (options.artifactsDir !== undefined) {
        resolved = resolveArtifactsTarget(options, triplet);
      } else {
        resolved = await resolveFeedTarget(options, env, triplet, currentVersion, fetchImpl);
        if (options.suiteZip !== undefined) {
          resolved.suite = { ...resolved.suite, path: options.suiteZip };
        }
      }
    } catch (error) {
      return finishFailure(failure(`failed to resolve the target release: ${(error as Error).message}`));
    }
    tx.toVersion = resolved.version;
    checkInterrupted();

    const desktopInstalled = existsSync(desktopAppExe(env, platform));
    const willUpdateDesktop =
      options.noDesktop !== true && (options.mode === 'install' || desktopInstalled);

    // No-op update: same suite version and the Desktop is already current.
    if (
      options.mode === 'update' &&
      currentVersion === resolved.version &&
      (!willUpdateDesktop || readDesktopVersion(prefix) === resolved.version)
    ) {
      await relaunchDesktopIfRequested();
      return upToDate(resolved.version, currentVersion);
    }

    // Step 3: refuse early when the Desktop is running and we cannot wait.
    if (willUpdateDesktop && options.waitPid === undefined) {
      if (await desktopIsRunning(runner, platform, env)) {
        return finishFailure(failure('啾啾工坊 is running; quit it and retry, or update from within Desktop'));
      }
    }

    // Step 4: download and stage both products.
    const stagingSuite = join(prefix, `.staging-${pid}`);
    removePath(stagingSuite, emit);
    mkdirSync(stagingSuite, { recursive: true });
    let suiteZipPath: string;
    try {
      if (resolved.suite.path !== undefined) {
        suiteZipPath = resolved.suite.path;
        const actual = sha256File(suiteZipPath);
        if (actual !== resolved.suite.sha256) {
          throw new Error(`sha256 mismatch for ${suiteZipPath} (expected ${resolved.suite.sha256}, got ${actual})`);
        }
      } else {
        suiteZipPath = join(stagingSuite, 'suite.zip');
        emit(`downloading suite ${resolved.version}`);
        await downloadFile({
          url: resolved.suite.url as string,
          dest: suiteZipPath,
          sha256: resolved.suite.sha256,
          fetchImpl,
          idleTimeoutMs,
        });
      }
      emit('extracting suite');
      await extractZip(suiteZipPath, stagingSuite, env, platform, runner);
      await validateSuite(stagingSuite, resolved.version, platform, env, runner);
      if (resolved.suite.path === undefined) {
        // Never leave the downloaded archive inside the kept version dir.
        removePath(suiteZipPath, emit);
      }
    } catch (error) {
      removePath(stagingSuite, emit);
      return finishFailure(failure(`failed to prepare the suite: ${(error as Error).message}`));
    }

    let stagingDesktop: string | null = null;
    let newDesktopApp: string | null = null;
    if (willUpdateDesktop) {
      if (resolved.desktop === null) {
        removePath(stagingSuite, emit);
        return finishFailure(failure('the release does not provide a Desktop asset'));
      }
      stagingDesktop = join(desktopParent, `.wrenyard-desktop-staging-${pid}`);
      removePath(stagingDesktop, emit);
      mkdirSync(stagingDesktop, { recursive: true });
      try {
        let desktopZipPath: string;
        if (resolved.desktop.path !== undefined) {
          desktopZipPath = resolved.desktop.path;
          const actual = sha256File(desktopZipPath);
          if (actual !== resolved.desktop.sha256) {
            throw new Error(`sha256 mismatch for ${desktopZipPath}`);
          }
        } else {
          desktopZipPath = join(stagingDesktop, 'desktop.zip');
          emit('downloading Desktop');
          await downloadFile({
            url: resolved.desktop.url as string,
            dest: desktopZipPath,
            sha256: resolved.desktop.sha256,
            fetchImpl,
            idleTimeoutMs,
          });
        }
        emit('extracting Desktop');
        await extractZip(desktopZipPath, stagingDesktop, env, platform, runner);
        newDesktopApp = stagedDesktopApp(stagingDesktop, platform);
        await validateDesktop(newDesktopApp, platform, env, runner);
        if (resolved.desktop.path === undefined) {
          // On Windows the staging dir is renamed wholesale into Programs, so a
          // downloaded desktop.zip would otherwise ship inside the app dir.
          removePath(desktopZipPath, emit);
        }
      } catch (error) {
        removePath(stagingSuite, emit);
        removePath(stagingDesktop, emit);
        return finishFailure(failure(`failed to prepare the Desktop: ${(error as Error).message}`));
      }
    }

    // Step 5: wait for the Desktop to exit when the caller gave us its pid.
    if (options.waitPid !== undefined) {
      const waitMs = options.desktopWaitTimeoutMs ?? DEFAULT_DESKTOP_WAIT_MS;
      const deadline = now() + waitMs;
      while (isProcessAlive(options.waitPid) && now() < deadline) {
        checkInterrupted();
        await sleep(200);
      }
      if (isProcessAlive(options.waitPid)) {
        removePath(stagingSuite, emit);
        if (stagingDesktop !== null) removePath(stagingDesktop, emit);
        return finishFailure(
          failure(`Desktop (pid ${options.waitPid}) did not exit within ${waitMs}ms; nothing was changed`),
        );
      }
    }

    // Step 6: record the in-progress transaction before any system change.
    writeInstallState(prefix, {
      pid,
      from: tx.fromVersion,
      to: resolved.version,
      previous_current: tx.previousCurrent,
    });
    tx.stateWritten = true;
    if (options.resultFile !== undefined) {
      writeResultFile(options.resultFile, {
        status: 'in_progress',
        from: tx.fromVersion,
        to: resolved.version,
        rolled_back: false,
      });
    }
    checkInterrupted();

    // Step 7: stop a running daemon through the current control tree.
    if (options.control !== undefined && tx.previousCurrent !== null) {
      const status = await options.control(['daemon', 'status', '--json']);
      const payload = parseDaemonStatus(status.stdout);
      if (payload === null && (status.error !== undefined || status.status !== 0)) {
        const restored = await rollback();
        return finishFailure(
          failure('the daemon is alive but its IPC is unreachable', restored, tx.fromVersion, tx.toVersion),
        );
      }
      if (payload !== null && payload.running) {
        tx.wasRunning = true;
        emit('stopping the daemon');
        const stopped = await options.control(['daemon', 'stop']);
        if (stopped.error !== undefined || stopped.status !== 0) {
          const restored = await rollback();
          return finishFailure(
            failure('failed to stop the running daemon', restored, tx.fromVersion, tx.toVersion),
          );
        }
        let lastLog = now();
        for (;;) {
          checkInterrupted();
          const poll = await options.control(['daemon', 'status', '--json']);
          // A SIGINT that killed the bridged status child must be honored even
          // though the synchronous bridge blocked the event loop while it ran.
          checkInterrupted();
          const polled = parseDaemonStatus(poll.stdout);
          if (polled !== null && !polled.running) break;
          if (polled === null && (poll.error !== undefined || poll.status !== 0)) {
            // The drain wait has no time limit: any failure here, including an
            // interrupted Ctrl-C, must roll back rather than abandon the system.
            const restored = await rollback();
            return finishFailure(
              failure(
                'the daemon is still alive but its IPC is unreachable',
                restored,
                tx.fromVersion,
                tx.toVersion,
              ),
            );
          }
          if (now() - lastLog >= 10_000) {
            emit('waiting for the daemon to drain');
            lastLog = now();
          }
          await sleep(pollMs);
        }
      }
    }

    // Step 8: place the staged suite.
    const newVersionDir = versionDir(prefix, resolved.version);
    mkdirSync(join(prefix, 'versions'), { recursive: true });
    if (existsSync(newVersionDir)) {
      const isCurrentTarget =
        currentVersionDir !== null &&
        sameRealTarget(realTarget(newVersionDir) ?? newVersionDir, realTarget(currentVersionDir) ?? currentVersionDir, platform);
      if (isCurrentTarget) {
        tx.oldSuiteDir = join(prefix, 'versions', `.${resolved.version}.old-${pid}`);
        removePath(tx.oldSuiteDir, emit);
        await renameWithRetry(newVersionDir, tx.oldSuiteDir);
      } else {
        removePath(newVersionDir, emit);
      }
    }
    await renameWithRetry(stagingSuite, newVersionDir);
    tx.placedSuite = true;
    checkInterrupted();

    // Step 9: switch `current` atomically and create the launcher on first install.
    await switchCurrent(prefix, newVersionDir, platform, pid);
    tx.switchedCurrent = true;
    if (tx.previousCurrent === null) {
      createLauncher(binDir, prefix, platform);
      tx.createdLauncher = true;
    }
    checkInterrupted();

    // Step 10: replace the Desktop application.
    if (willUpdateDesktop && newDesktopApp !== null) {
      if (options.waitPid === undefined && (await desktopIsRunning(runner, platform, env))) {
        const restored = await rollback();
        return finishFailure(
          failure(
            '啾啾工坊 started during the update; aborting before replacing it',
            restored,
            tx.fromVersion,
            resolved.version,
          ),
        );
      }
      const backup = join(desktopParent, `.previous-${pid}`);
      if (existsSync(desktopTarget)) {
        removePath(backup, emit);
        // Journal the backup path *before* renaming the old app: a crash in the
        // window between the rename and the state write must not lose the only
        // copy of the old app. `tx.desktopBackup` is set only after the rename
        // succeeds, so a failed rename never makes rollback delete an untouched
        // old app.
        writeInstallState(prefix, {
          pid,
          from: tx.fromVersion,
          to: resolved.version,
          previous_current: tx.previousCurrent,
          desktop_backup: backup,
        });
        // Unregister the old app from LaunchServices *before* it moves;
        // unregistering the backup path after the rename is a no-op and leaves
        // the stale registration in place.
        if (!isWindows(platform)) {
          const unregistered = await runner(MACOS_LSREGISTER, ['-u', desktopTarget], { env });
          if (unregistered.error !== undefined || unregistered.status !== 0) {
            throw new Error(
              `lsregister -u failed for ${desktopTarget}: ${unregistered.error?.message ?? unregistered.stderr.trim()}`,
            );
          }
        }
        await renameWithRetry(desktopTarget, backup);
        tx.desktopBackup = backup;
      }
      await renameWithRetry(newDesktopApp, desktopTarget);
      tx.desktopReplaced = true;
      if (!isWindows(platform)) {
        const registered = await runner(MACOS_LSREGISTER, ['-f', desktopTarget], { env });
        if (registered.error !== undefined || registered.status !== 0) {
          throw new Error(
            `lsregister -f failed for ${desktopTarget}: ${registered.error?.message ?? registered.stderr.trim()}`,
          );
        }
      } else if (!desktopInstalled) {
        const shortcut = await createWindowsShortcut(env, runner, desktopAppExe(env, platform));
        if (shortcut.error !== undefined || shortcut.status !== 0) {
          throw new Error(
            `failed to create the Start Menu shortcut: ${shortcut.error?.message ?? shortcut.stderr.trim()}`,
          );
        }
      }
    }
    checkInterrupted();

    // Step 11: start the new daemon and health-check it.
    if (tx.wasRunning) {
      emit('starting the updated daemon');
      await runner(launcher, ['daemon', 'start'], { env: launchEnv(env) });
      const healthMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_MS;
      const deadline = now() + healthMs;
      const wanted = realTarget(newVersionDir) ?? newVersionDir;
      let healthy = false;
      while (now() < deadline) {
        checkInterrupted();
        const status = await runner(launcher, ['service', 'status', '--json'], { env: launchEnv(env) });
        const payload = status.status === 0 ? parseDaemonStatus(status.stdout) : null;
        if (payload !== null && daemonHealthyFor(payload, wanted, platform)) {
          healthy = true;
          break;
        }
        await sleep(pollMs);
      }
      if (!healthy) {
        const restored = await rollback();
        return finishFailure(
          failure('the restarted daemon failed its health check', restored, tx.fromVersion, resolved.version),
        );
      }
    } else {
      const probe = await runner(launcher, ['--version'], { env: launchEnv(env) });
      if (probe.error !== undefined || probe.status !== 0) {
        const restored = await rollback();
        return finishFailure(
          failure('the installed suite failed to run', restored, tx.fromVersion, resolved.version),
        );
      }
    }

    // Step 13: finalize. The transaction is committed: a failure from here on
    // is only a warning and must never report or trigger a rollback.
    tx.committed = true;
    const finalize = (label: string, action: () => void): void => {
      try {
        action();
      } catch (error) {
        emit(`finalize: ${label} failed: ${(error as Error).message}`);
      }
    };
    finalize('clear install state', () => clearInstallState(prefix));
    finalize('remove staging', () => {
      if (tx.desktopBackup !== null) removePath(tx.desktopBackup, emit);
      removePath(stagingSuite, emit);
      if (stagingDesktop !== null) removePath(stagingDesktop, emit);
      if (tx.oldSuiteDir !== null) removePath(tx.oldSuiteDir, emit);
    });
    finalize('prune versions', () => {
      const keep = new Set<string>([resolved.version]);
      if (tx.previousCurrent !== null) {
        keep.add(basename(resolve(prefix, tx.previousCurrent)));
      } else if (tx.fromVersion !== undefined) {
        keep.add(tx.fromVersion);
      }
      cleanupVersions(prefix, keep, runningDir, emit);
    });
    if (willUpdateDesktop && (tx.desktopReplaced || !desktopInstalled)) {
      finalize('write desktop-version', () => writeDesktopVersion(prefix, resolved.version));
    }
    if (options.resultFile !== undefined) {
      const resultFile = options.resultFile;
      finalize('write result file', () =>
        writeResultFile(resultFile, { status: 'ok', from: tx.fromVersion, to: resolved.version, rolled_back: false }),
      );
    }
    emit(`installed wrenyard ${resolved.version}`);
    await relaunchDesktopIfRequested();
    return succeed(resolved.version, tx.fromVersion);
  } catch (error) {
    const restored = await rollback();
    return finishFailure(failure((error as Error).message, restored, tx.fromVersion, tx.toVersion));
  } finally {
    if (options.installSignalHandlers !== false) {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      if (platform === 'win32') process.removeListener('SIGBREAK', onInterrupt);
    }
    releaseLock?.();
  }
}
