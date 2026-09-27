/** Filesystem primitives for the SEA install engine (spec section 5.2/5.3). */

import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  CURRENT_LINK,
  DESKTOP_VERSION_FILE,
  INSTALL_LOCK_FILE,
  INSTALL_STATE_FILE,
  SUITE_VERSION_FILE,
  isWindows,
  launcherFileName,
  suiteExecutableName,
  windowsLauncherContent,
} from './platform.js';

const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;

/** True while `pid` names a live process; EPERM means it exists but is foreign. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Promise-based delay; the retry helpers are async so tests stay deterministic. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function isRetryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && RETRYABLE_CODES.has(code);
}

/** Rename with bounded retries; only the caller decides when a failure is fatal. */
export async function renameWithRetry(
  from: string,
  to: string,
  attempts = RENAME_ATTEMPTS,
  renameImpl: (from: string, to: string) => void = renameSync,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameImpl(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) throw error;
      await sleep(100 + attempt * 30);
    }
  }
  throw lastError;
}

/** Recursive removal with the standard retry policy; warns instead of throwing. */
export function removePath(path: string, log?: (line: string) => void): boolean {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch (error) {
    log?.(`warning: could not remove ${path}: ${(error as Error).message}`);
    return false;
  }
}

/** Removes a symlink or Windows junction without following it into its target. */
export function removeLink(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return false;
    if (isWindows(platform)) rmdirSync(path);
    else unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Link target of `current`, or null when it is absent or not a link. */
export function readCurrent(prefix: string): string | null {
  try {
    return readlinkSync(join(prefix, CURRENT_LINK));
  } catch {
    return null;
  }
}

/** Real path of a link or directory, or null when it cannot be resolved. */
export function realTarget(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Compare resolved targets: case-insensitive on Windows, exact elsewhere. */
export function sameRealTarget(a: string, b: string, platform: NodeJS.Platform): boolean {
  if (isWindows(platform)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Atomically point `current` at `versionDir` without recursing into junctions. */
export async function switchCurrent(
  prefix: string,
  versionDir: string,
  platform: NodeJS.Platform,
  pid: number,
): Promise<void> {
  const currentPath = join(prefix, CURRENT_LINK);
  if (!isWindows(platform)) {
    const temp = join(prefix, `.current-${pid}`);
    rmSync(temp, { force: true });
    symlinkSync(relative(prefix, versionDir), temp);
    renameSync(temp, currentPath);
    return;
  }
  let oldLink: string | undefined;
  if (existsSync(currentPath)) {
    const stat = lstatSync(currentPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`refusing to replace ${currentPath}: it is not a junction`);
    }
    oldLink = join(prefix, `.current-old-${pid}`);
    rmSync(oldLink, { force: true });
    await renameWithRetry(currentPath, oldLink);
  }
  symlinkSync(versionDir, currentPath, 'junction');
  if (oldLink !== undefined && !removeLink(oldLink, platform)) {
    throw new Error(`refusing to remove ${oldLink}: it is not a junction`);
  }
}

/** Create or refresh the bin launcher that delegates to `<prefix>/current`. */
export function createLauncher(binDir: string, prefix: string, platform: NodeJS.Platform): void {
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, launcherFileName(platform));
  if (isWindows(platform)) {
    writeFileSync(launcher, windowsLauncherContent(prefix));
    return;
  }
  rmSync(launcher, { force: true });
  symlinkSync(join(prefix, CURRENT_LINK, 'wrenyard'), launcher);
}

/** `<prefix>/versions/<v>` for a version string. */
export function versionDir(prefix: string, version: string): string {
  return join(prefix, 'versions', version);
}

/** Version directory names present under `<prefix>/versions`, sorted ascending. */
export function listVersions(prefix: string): string[] {
  try {
    return readdirSync(join(prefix, 'versions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Read `<versionDir>/SUITE_VERSION`, or null when it is absent. */
export function readSuiteVersion(versionDirPath: string): string | null {
  try {
    const value = readFileSync(join(versionDirPath, SUITE_VERSION_FILE), 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** In-progress operation record used for interrupted-run recovery. */
export interface InstallState {
  pid: number;
  from?: string;
  to: string;
  previous_current: string | null;
  desktop_backup?: string;
}

/** Reads `install-state.json`, or null when absent or malformed. */
export function readInstallState(prefix: string): InstallState | null {
  let raw: string;
  try {
    raw = readFileSync(join(prefix, INSTALL_STATE_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as InstallState;
    if (typeof parsed.pid !== 'number' || typeof parsed.to !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Writes `install-state.json` before any system change is made. */
export function writeInstallState(prefix: string, state: InstallState): void {
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, INSTALL_STATE_FILE), JSON.stringify(state, null, 2));
}

/** Removes `install-state.json`; only called once the transaction is settled. */
export function clearInstallState(prefix: string): void {
  rmSync(join(prefix, INSTALL_STATE_FILE), { force: true });
}

/** Thrown when another live install/update already holds `<prefix>/install.lock`. */
export class InstallLockHeldError extends Error {
  constructor(readonly holderPid: number | null) {
    super(
      holderPid === null
        ? 'another install/update is running'
        : `another install/update is running (pid ${holderPid})`,
    );
    this.name = 'InstallLockHeldError';
  }
}

export function acquireInstallLock(prefix: string, pid: number, now: () => number): () => void {
  mkdirSync(prefix, { recursive: true });
  const lockPath = join(prefix, INSTALL_LOCK_FILE);
  const create = (): boolean => {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ pid, startedAt: new Date(now()).toISOString() }));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };
  if (create()) return releaseLock(lockPath, pid);
  const holder = readLockPid(lockPath);
  if (holder !== null && isProcessAlive(holder)) throw new InstallLockHeldError(holder);
  rmSync(lockPath, { force: true });
  if (!create()) throw new InstallLockHeldError(readLockPid(lockPath));
  return releaseLock(lockPath, pid);
}

function readLockPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

function releaseLock(lockPath: string, pid: number): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (readLockPid(lockPath) === pid) rmSync(lockPath, { force: true });
  };
}

/** Trailing `-<pid>` marker used by every staging/backup directory name. */
export function trailingPid(name: string): number | null {
  const match = /-(\d+)$/.exec(name);
  if (match === null) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) ? pid : null;
}

/** True when `path` is the directory the currently executing engine lives in. */
function isRunningDir(
  path: string,
  runningDir: string | null,
  platform: NodeJS.Platform,
): boolean {
  if (runningDir === null) return false;
  const resolved = realTarget(path);
  return resolved !== null && sameRealTarget(resolved, runningDir, platform);
}

/** Removes a leftover dir unless its owner is alive or it is the running engine's dir. */
function safeRemoveDir(
  path: string,
  pid: number | null,
  log: (line: string) => void,
  runningDir: string | null = null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (pid !== null && isProcessAlive(pid)) return false;
  if (isRunningDir(path, runningDir, platform)) return false;
  return removePath(path, log);
}

/** Newest version directory whose `SUITE_VERSION` and suite executable are valid. */
function newestVersionDir(prefix: string, platform: NodeJS.Platform): string | null {
  const versions = listVersions(prefix);
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const name = versions[index] as string;
    const candidate = versionDir(prefix, name);
    if (readSuiteVersion(candidate) !== name) continue;
    if (!existsSync(join(candidate, suiteExecutableName(platform)))) continue;
    return candidate;
  }
  return null;
}

/** Step 0: repair an interrupted run, then sweep leftovers whose owner is gone. */
export async function recoverInterrupted(
  prefix: string,
  platform: NodeJS.Platform,
  log: (line: string) => void,
  pid: number,
  desktopTarget?: string,
  runningDir: string | null = null,
): Promise<void> {
  if (!existsSync(prefix)) return;
  const state = readInstallState(prefix);
  const journal = state !== null && !isProcessAlive(state.pid) ? state : null;

  // Rename `.old-*` back before picking the `current` target.
  const versionsPath = join(prefix, 'versions');
  if (existsSync(versionsPath)) {
    for (const entry of readdirSync(versionsPath, { withFileTypes: true })) {
      const match = /^\.(.+)\.old-(\d+)$/.exec(entry.name);
      if (match === null) continue;
      const version = match[1] as string;
      const owner = Number(match[2]);
      if (isProcessAlive(owner)) continue;
      const oldPath = join(versionsPath, entry.name);
      const restoreTo = versionDir(prefix, version);
      if (!existsSync(restoreTo)) {
        await renameWithRetry(oldPath, restoreTo);
      } else if (journal !== null && journal.to === version) {
        // Interrupted same-version reinstall: versions/<v> is the untrusted
        // new copy, so drop it and restore the known-good old directory —
        // unless this engine runs from it; a later run finishes the restore.
        if (isRunningDir(restoreTo, runningDir, platform)) {
          log(`recovery: ${restoreTo} is the running engine directory; leaving ${oldPath} for a later run`);
          continue;
        }
        removePath(restoreTo, log);
        await renameWithRetry(oldPath, restoreTo);
      } else {
        safeRemoveDir(oldPath, owner, log, runningDir, platform);
      }
    }
  }

  if (journal !== null) {
    let target: string | null = null;
    if (typeof journal.previous_current === 'string' && journal.previous_current.length > 0) {
      const recorded = resolve(prefix, journal.previous_current);
      if (existsSync(recorded)) target = recorded;
    }
    if (target === null) target = newestVersionDir(prefix, platform);
    if (target !== null) await switchCurrent(prefix, target, platform, pid);
    if (desktopTarget !== undefined && typeof journal.desktop_backup === 'string') {
      if (existsSync(journal.desktop_backup) && !existsSync(desktopTarget)) {
        await renameWithRetry(journal.desktop_backup, desktopTarget);
      }
    }
    log(`recovered an interrupted install (to ${journal.to}); current=${target ?? 'unchanged'}`);
    clearInstallState(prefix);
  }

  // Sweep leftovers whose owner is gone; the sweep never throws.
  for (const entry of readdirSync(prefix, { withFileTypes: true })) {
    const full = join(prefix, entry.name);
    if (entry.name.startsWith('.staging-')) {
      safeRemoveDir(full, trailingPid(entry.name), log, runningDir, platform);
    } else if (entry.name.startsWith('.current-')) {
      const owner = trailingPid(entry.name);
      if (owner === null || !isProcessAlive(owner)) removeLink(full, platform);
    }
  }
  if (desktopTarget !== undefined && existsSync(dirname(desktopTarget))) {
    for (const entry of readdirSync(dirname(desktopTarget), { withFileTypes: true })) {
      const full = join(dirname(desktopTarget), entry.name);
      if (entry.name.startsWith('.wrenyard-desktop-staging-')) {
        safeRemoveDir(full, trailingPid(entry.name), log, runningDir, platform);
      } else if (entry.name.startsWith('.previous-') && existsSync(desktopTarget)) {
        safeRemoveDir(full, trailingPid(entry.name), log, runningDir, platform);
      }
    }
  }
}

/** Finalize cleanup: keep `keep` version dirs, never the running engine's own dir. */
export function cleanupVersions(
  prefix: string,
  keep: ReadonlySet<string>,
  runningDir: string | null,
  log: (line: string) => void,
): void {
  const versionsPath = join(prefix, 'versions');
  if (!existsSync(versionsPath)) return;
  for (const entry of readdirSync(versionsPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (keep.has(entry.name)) continue;
    const full = join(versionsPath, entry.name);
    if (runningDir !== null && realTarget(full) === realTarget(runningDir)) continue;
    if (!removePath(full, log)) {
      log(`warning: kept stale version ${entry.name}; the next run will retry`);
    }
  }
}

/** Reads `desktop-version`, or null when the file is absent. */
export function readDesktopVersion(prefix: string): string | null {
  try {
    const value = readFileSync(join(prefix, DESKTOP_VERSION_FILE), 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Writes `desktop-version` after a successful Desktop install or replacement. */
export function writeDesktopVersion(prefix: string, version: string): void {
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, DESKTOP_VERSION_FILE), `${version}\n`);
}

/** Appends a line to `<stateRoot>/logs/update.log`, best-effort. */
export function appendUpdateLog(logDir: string, line: string): void {
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'update.log'), `${line}\n`, { flag: 'a' });
  } catch {
    // Logging must never fail an install.
  }
}

/** Writes the Desktop-facing result file, best-effort. */
export function writeResultFile(
  path: string,
  payload: { status: string; from?: string; to?: string; message?: string; rolled_back?: boolean },
): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(payload, null, 2));
  } catch {
    // The result file is advisory; Desktop also reads update.log.
  }
}

/** Makes a file executable, ignoring a missing file. */
export function makeExecutable(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch {
    // The suite validation step reports a missing executable separately.
  }
}
