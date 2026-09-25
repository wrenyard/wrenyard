import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { foremanStateRoot } from '@wrenyard/daemon/config/state'

const DEV_STATE_DIR_NAME = 'dev'
const DEV_LOCK_FILE_NAME = 'dev.lock'

/** A live `pnpm dev` source checkout that owns the Wrenyard daemon. */
export interface SourceDevLock {
  /** Pid of the `pnpm dev` process that wrote the lock. */
  pid: number
  /** Absolute path of the source checkout that `pnpm dev` is running from. */
  checkout: string
  /** Full argv that starts the source CLI (node, tsx cli, apps/cli/src/index.ts), written by pnpm dev. */
  cli?: string[]
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

/**
 * Read the live source-dev lock at `<state>/dev/dev.lock`, if any.
 *
 * The lock is written by `pnpm dev` with `{ pid, checkout, startedAt }` and is
 * treated as live only while its holder pid is still running. A missing,
 * malformed, or dead-holder lock returns undefined so callers fall back to
 * their normal behavior. An optional `cli` field is returned when the lock
 * carries a valid argv array.
 */
export function readSourceDevLock(): SourceDevLock | undefined {
  const lockPath = join(foremanStateRoot(), DEV_STATE_DIR_NAME, DEV_LOCK_FILE_NAME)
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

  const { pid, checkout, cli } = parsed as { pid?: unknown; checkout?: unknown; cli?: unknown }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof checkout !== 'string' || !checkout.trim()) return undefined
  if (!isProcessAlive(pid)) return undefined

  const lock: SourceDevLock = { pid, checkout }
  if (
    Array.isArray(cli) &&
    cli.length >= 2 &&
    cli.every((part) => typeof part === 'string' && part.length > 0)
  ) {
    lock.cli = cli
  }
  return lock
}

/**
 * Exact refusal message shared by every entry point that must not race a live
 * `pnpm dev` stack (daemon start, daemon restart, update).
 */
export function sourceDevLockRefusalMessage(lock: SourceDevLock): string {
  return `pnpm dev (pid ${lock.pid}, checkout ${lock.checkout}) owns the Wrenyard daemon and restarts it itself. Do not start another daemon; wait for it, or stop pnpm dev first.`
}

/**
 * Extra line printed by `wrenyard daemon stop` after a successful stop while a
 * live source-dev lock remains, so the human knows the daemon will come back.
 */
export function sourceDevStopNotice(): string {
  return 'pnpm dev will start the daemon again; press Ctrl+C in pnpm dev to stop the whole stack.'
}
