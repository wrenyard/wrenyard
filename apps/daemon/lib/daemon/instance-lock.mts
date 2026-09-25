import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One-line JSON written to `daemon.lock`; the field names are a shared wire contract. */
export interface InstanceLockRecord {
  pid: number
  mode: 'source' | 'installed'
  startedAt: string
}

/**
 * Writes the record with an exclusive create. A lock already held by a live
 * process (including this same process) is refused; a stale lock is removed and
 * the write is retried once.
 */
export function acquireInstanceLock(path: string, record: InstanceLockRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const holder = readLiveInstanceLock(path)
    if (holder) {
      throw new Error(`Another Wrenyard daemon is running (pid ${holder.pid}, ${holder.mode}, since ${holder.startedAt}). Stop it before starting a new one.`)
    }
    rmSync(path, { force: true })
  }
  throw new Error(`Could not acquire ${path}`)
}

/** Returns the record only when its pid is alive; unreadable or dead records count as stale. */
export function readLiveInstanceLock(path: string): InstanceLockRecord | undefined {
  const record = readInstanceLock(path)
  if (!record || !isProcessAlive(record.pid)) return undefined
  return record
}

/** Removes the file only when it still records this process. */
export function releaseInstanceLock(path: string): void {
  const record = readInstanceLock(path)
  if (!record || record.pid !== process.pid) return
  rmSync(path, { force: true })
}

function readInstanceLock(path: string): InstanceLockRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as { pid?: unknown; mode?: unknown; startedAt?: unknown }
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return undefined
  if (record.mode !== 'source' && record.mode !== 'installed') return undefined
  if (typeof record.startedAt !== 'string') return undefined
  return { pid: record.pid, mode: record.mode, startedAt: record.startedAt }
}

/** `process.kill(pid, 0)` probes liveness: ESRCH means gone, EPERM still counts as alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
