import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { foremanStateRoot } from '../../config/state.mts'

const LOCK_FILE_NAME = 'planned-restart.lock'
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_TIMEOUT_MS = 10_000
const MALFORMED_RECLAIM_AGE_MS = 30_000
const STALE_LIVE_PID_RECLAIM_AGE_MS = 60_000

/**
 * Error raised when the advisory lock cannot be acquired within the poll
 * timeout because another live process holds it.
 */
export class PlannedRestartLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlannedRestartLockError'
  }
}

export interface PlannedRestartLock {
  /** Path to the lock file that was created. */
  path: string
  /**
   * Release the lock by unlinking the file. Re-reads the file first and
   * unlinks ONLY when the ownership token still matches, so a path-only
   * release can never remove someone else's live lock. Idempotent; errors
   * are swallowed.
   */
  release: () => void
}

interface LockContent {
  /** Raw byte content of the lock file, used for byte-identical re-verification. */
  raw: string
  pid: number | null
  token: string | null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLockContent(lockPath: string): LockContent | null {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch {
    return null
  }
  const pidMatch = raw.match(/^pid=(\d+)/m)
  const tokenMatch = raw.match(/^token=([0-9a-f]+)/m)
  const pid = pidMatch ? Number(pidMatch[1]) : null
  return {
    raw,
    pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null,
    token: tokenMatch ? tokenMatch[1] : null,
  }
}

function tryCreateLock(lockPath: string, token: string): boolean {
  try {
    // O_EXCL ('wx'): atomically create, failing if the file already exists.
    writeFileSync(
      lockPath,
      `pid=${process.pid}\nts=${new Date().toISOString()}\ntoken=${token}\n`,
      { flag: 'wx', encoding: 'utf8' },
    )
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    throw error
  }
}

function fileMtimeMs(lockPath: string): number | null {
  try {
    return statSync(lockPath).mtimeMs
  } catch {
    return null
  }
}

/**
 * Acquire the planned-restart advisory lock under the foreman state root.
 *
 * The lock is a small file created with O_EXCL so the create is atomic. The
 * content includes a holder pid, an ISO timestamp, and a random ownership
 * token. If the file already exists:
 *
 * - Any lock whose mtime is older than `staleLivePidAgeMs` (default 60s) is
 *   reclaimed regardless of holder-pid liveness. This is an age backstop
 *   against PID reuse: the critical section (decide+launch) completes in
 *   seconds and the terminal wait runs outside the lock, so a 60s-old lock
 *   is definitionally stale. The age cap bounds liveness independent of pid
 *   semantics.
 * - A dead holder pid is reclaimed (regardless of age).
 * - A malformed or null-pid lock is reclaimable once its mtime is older than
 *   `reclaimAgeMs` (default 30s, so a null-pid lock never blocks forever).
 * - A live holder pid with a recent mtime is polled at `pollIntervalMs` up to
 *   `timeoutMs` before throwing {@link PlannedRestartLockError}.
 *
 * `release()` re-reads the file and unlinks ONLY when the token still matches,
 * so a path-only release can never remove someone else's live lock.
 *
 * Residual ABA: between the staleness decision and the unlink, another process
 * may reclaim and re-create the lock. The byte-identical re-read before unlink
 * shrinks this window but cannot eliminate it. The residual ABA is bounded by
 * downstream convergence (the durable store's operation-id guards and the
 * coordinator's self-ownership checks), not by this lock.
 */
export async function acquirePlannedRestartLockAsync(options?: {
  stateRoot?: string
  pollIntervalMs?: number
  timeoutMs?: number
  reclaimAgeMs?: number
  staleLivePidAgeMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Injectable unlink for tests (e.g. to simulate EPERM). Defaults to fs.unlinkSync. */
  unlink?: (path: string) => void
}): Promise<PlannedRestartLock> {
  const stateRoot = options?.stateRoot ?? foremanStateRoot()
  const lockPath = join(stateRoot, LOCK_FILE_NAME)
  const pollInterval = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const reclaimAge = options?.reclaimAgeMs ?? MALFORMED_RECLAIM_AGE_MS
  const staleLivePidAge = options?.staleLivePidAgeMs ?? STALE_LIVE_PID_RECLAIM_AGE_MS
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options?.now ?? (() => Date.now())
  const unlink = options?.unlink ?? unlinkSync

  mkdirSync(dirname(lockPath), { recursive: true })

  const deadline = now() + timeout
  while (true) {
    const token = randomBytes(8).toString('hex')
    if (tryCreateLock(lockPath, token)) {
      return {
        path: lockPath,
        release: () => releaseLock(lockPath, token),
      }
    }

    const content = readLockContent(lockPath)
    if (content === null) {
      // File was removed between the failed create and the read; retry.
      if (now() >= deadline) {
        throw new PlannedRestartLockError(`another planned restart operation is in progress (lock at ${lockPath})`)
      }
      await sleep(pollInterval)
      continue
    }

    const mtime = fileMtimeMs(lockPath)
    const age = mtime !== null ? now() - mtime : Infinity

    // Case 0: age backstop — any lock older than staleLivePidAge (60s) is
    // reclaimable regardless of holder-pid liveness. This bounds liveness
    // independent of pid semantics (PID reuse, EPERM on foreign pids, etc.).
    if (age >= staleLivePidAge) {
      if (tryReclaimStale(lockPath, content.raw, unlink)) {
        continue
      }
      // Content changed or unlink failed — fall through to the wait.
    }

    // Case 1: valid holder pid, holder is dead → reclaim.
    if (content.pid !== null && !isProcessAlive(content.pid)) {
      if (tryReclaimStale(lockPath, content.raw, unlink)) {
        continue
      }
      // Content changed — fall through to the wait.
    }

    // Case 2: malformed or null-pid lock → reclaimable after age threshold.
    if (content.pid === null && age >= reclaimAge) {
      if (tryReclaimStale(lockPath, content.raw, unlink)) {
        continue
      }
    }

    // Case 3: live holder or not yet reclaimable → poll.
    if (now() >= deadline) {
      throw new PlannedRestartLockError(
        `another planned restart operation is in progress (lock at ${lockPath}, holder pid ${content.pid ?? 'unknown'})`,
      )
    }
    await sleep(pollInterval)
  }
}

/**
 * Reclaim a stale lock: re-read the file and unlink ONLY when the raw content
 * is byte-identical to `expectedRaw`. Returns true if the lock was reclaimed
 * (unlinked or already gone via ENOENT), false if the content changed or the
 * unlink failed with a non-ENOENT error (e.g. EPERM/EACCES). On failure the
 * acquire continues the normal bounded wait and hits the timeout with a clear
 * error, rather than looping forever on a persistent permission issue.
 */
function tryReclaimStale(
  lockPath: string,
  expectedRaw: string,
  unlink: (path: string) => void,
): boolean {
  const current = readLockContent(lockPath)
  if (current === null || current.raw !== expectedRaw) {
    // Content changed or file removed — do not unlink someone else's lock.
    return false
  }
  try {
    unlink(lockPath)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // Someone else already unlinked it; treat as reclaimed.
      return true
    }
    // EACCES, EPERM, EBUSY, etc. → reclaim failed. Do not treat as success;
    // the acquire continues the bounded wait and hits the timeout.
    return false
  }
}

function releaseLock(lockPath: string, expectedToken: string): void {
  const content = readLockContent(lockPath)
  if (content === null) {
    // Already removed.
    return
  }
  // Token-checked release: only unlink when the token still matches, so a
  // path-only release can never remove someone else's live lock.
  if (content.token !== expectedToken) {
    return
  }
  try {
    unlinkSync(lockPath)
  } catch {
    // Idempotent: already removed.
  }
}
