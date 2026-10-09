import { join } from 'node:path'
import { foremanStateRoot } from '@wrenyard/daemon/config/state'
import type { ForemanServiceConfig } from '@wrenyard/daemon/config'
import { resolveWrenyardIpcPath } from '@wrenyard/control'
import { readLiveInstanceLock } from '@wrenyard/daemon/daemon/instance-lock'
import { ipcCall } from '@wrenyard/daemon/supervisor'
import { isIpcReachable, sleep } from './shared.mts'

const ACTIVE_COUNT_NOTICE_MS = 10_000

export interface DaemonLifecycleOptions {
  config: ForemanServiceConfig
  resolvedConfigPath: string
  shutdownForce?: boolean
}

export interface DaemonLifecycleResult {
  graceful: boolean
  forced: boolean
}

/** The daemon's own single-instance lock; its absence means no daemon is running. */
export function resolveDaemonLockPath(): string {
  return join(foremanStateRoot(), 'daemon.lock')
}

/**
 * Daemon state for `daemon status`/`doctor`: only `health.ping` connectivity and
 * the `daemon.lock` the daemon itself writes. A detached pid/state file is gone.
 */
export interface DaemonSupervisorStatus {
  running: boolean
  status: 'running' | 'stopped'
  pid?: number
  startedAt?: string
  mode?: 'source' | 'installed'
}

export async function readDaemonSupervisorStatus(options: DaemonLifecycleOptions): Promise<DaemonSupervisorStatus> {
  const ipcPath = resolveWrenyardIpcPath(process.env, { config: options.config })
  const lock = readLiveInstanceLock(resolveDaemonLockPath())
  const reachable = await isIpcReachable(ipcPath)
  return {
    running: reachable,
    status: reachable ? 'running' : 'stopped',
    ...(lock ? { pid: lock.pid, startedAt: lock.startedAt, mode: lock.mode } : {}),
  }
}

/**
 * Stop the running daemon through IPC: send `daemon.shutdown`, wait for the
 * `daemon.lock` to be released and the endpoint to go unreachable, and never
 * convert a slow drain into a kill. `--force` skips the drain on the daemon.
 */
export async function stopDaemonProcess(options: DaemonLifecycleOptions): Promise<DaemonLifecycleResult> {
  const ipcPath = resolveWrenyardIpcPath(process.env, { config: options.config })
  const lockPath = resolveDaemonLockPath()
  const reachable = await isIpcReachable(ipcPath)
  if (reachable) {
    await ipcCall(ipcPath, 'daemon.shutdown', {
      reason: 'wrenyard daemon stop',
      force: options.shutdownForce === true,
    })
  } else {
    const lock = readLiveInstanceLock(lockPath)
    if (lock) {
      throw new Error(`Wrenyard daemon pid ${lock.pid} is alive but IPC is unreachable at ${ipcPath}; graceful shutdown could not be requested`)
    }
  }

  // The daemon owns its drain and exit; the caller never converts a slow
  // shutdown into a kill. Active counts go to stderr every 10s.
  const reporter = startActiveCountReporter(ipcPath)
  try {
    while (await isIpcReachable(ipcPath)) await sleep(200)
    // The daemon removes daemon.lock as its final act; wait for it without a
    // deadline so a slow drain is never cut short.
    while (readLiveInstanceLock(lockPath)) await sleep(200)
  } finally {
    reporter.stop()
  }

  return { graceful: reachable, forced: options.shutdownForce === true }
}

/**
 * Prints the daemon's active-work counts every 10 seconds while a stop drains.
 * Queries that fail because the daemon already stopped are ignored.
 */
function startActiveCountReporter(ipcPath: string): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      const status = await ipcCall(ipcPath, 'daemon.status', {}) as Record<string, unknown>
      process.stderr.write(`Active tasks: ${Number(status.activeTaskCount ?? 0)}, workflows: ${Number(status.activeWorkflowCount ?? 0)}, executions: ${Number(status.activeExecutionCount ?? 0)}\n`)
    } catch {
      // The daemon may already be stopping; the stop owns the outcome.
    }
  }
  const timer = setInterval(() => { void tick() }, ACTIVE_COUNT_NOTICE_MS)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
