/// <reference path="./cross-spawn.d.ts" />
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import crossSpawn from 'cross-spawn'

const nativeSpawn = crossSpawn as (
  command: string, args: readonly string[], options: SpawnOptions,
) => ChildProcess
const PROCESS_TREE_KILL_GRACE_MS = 10_000
const PROCESS_TREE_KILL_POLL_MS = 100

/** Shared native spawn, including Windows npm shims and argument escaping. */
export function spawnProcess(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  return nativeSpawn(command, args, { ...options, shell: false, windowsHide: resolveWindowsHideOption(options) })
}
export function spawnShellProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawnProcess(command, args, options)
}

export function resolveWindowsHideOption(options: { windowsHide?: boolean }): boolean | undefined {
  return options.windowsHide ?? (process.platform === 'win32' ? true : undefined)
}

export interface OwnedUnixLaunch {
  readonly child: ChildProcess
  readonly marker: string
  cleanup(): Promise<void>
}

// Marker discovery is best-effort and requires an unchanged inherited environment outside the original group. Darwin start identities have second-level resolution and PID revalidation is snapshot-based, not a kernel handle; environment-cleared or privilege-crossing detached children are not guaranteed discoverable.
/** Launch an execution with a private inherited marker and settle its Unix scope. */
export function spawnOwnedUnixProcess(
  command: string, args: readonly string[], options: SpawnOptions = {},
): OwnedUnixLaunch {
  if (process.platform === 'win32') throw new Error('Unix owned launch is unavailable on Windows')
  const marker = randomBytes(32).toString('hex')
  const markerName = 'WRENYARD_EXECUTION_OWNER'
  const child = spawnProcess(command, args, {
    ...options,
    detached: true,
    env: { ...(options.env ?? {}), [markerName]: marker },
  })
  let cleanupPromise: Promise<void> | undefined
  return {
    child,
    marker,
    cleanup: () => {
      cleanupPromise ??= cleanupUnixOwnedProcesses(marker, child.pid)
      return cleanupPromise
    },
  }
}

async function cleanupUnixOwnedProcesses(marker: string, rootPid?: number): Promise<void> {
  if (rootPid !== undefined) await terminateVerifiedUnixProcess(rootPid, marker)
  const deadline = Date.now() + PROCESS_TREE_KILL_GRACE_MS
  let emptySnapshots = 0
  while (Date.now() < deadline) {
    const targets = await discoverUnixMarkerProcesses(marker)
    if (targets.length === 0) {
      if (++emptySnapshots >= 3) break
      await sleep(PROCESS_TREE_KILL_POLL_MS)
      continue
    }
    emptySnapshots = 0
    await Promise.all(targets.map((target) => terminateVerifiedUnixProcess(target.pid, marker, target.startIdentity)))
    await sleep(PROCESS_TREE_KILL_POLL_MS)
  }
  const remaining = await discoverUnixMarkerProcesses(marker)
  if (remaining.length > 0) throw new Error('owned Unix execution cleanup could not confirm marker-bearing processes exited')
  if (rootPid !== undefined) await killProcessTree(rootPid, rootPid)
}

type OwnedUnixProcess = { pid: number; startIdentity: string }

async function discoverUnixMarkerProcesses(marker: string): Promise<OwnedUnixProcess[]> {
  if (process.platform === 'linux') return discoverLinuxMarkerProcesses(marker)
  if (process.platform === 'darwin') return discoverMacMarkerProcesses(marker)
  throw new Error(`owned Unix process discovery is unsupported on ${process.platform}`)
}

async function terminateVerifiedUnixProcess(pid: number, marker: string, expectedStart?: string): Promise<void> {
  if (!isSafeUnixProcessId(pid)) throw new Error(`owned process cleanup refused unsafe PID ${pid}`)
  const identity = await readUnixProcessIdentity(pid, marker)
  if (!identity || (expectedStart !== undefined && identity.startIdentity !== expectedStart)) return
  const beforeTerm = await readUnixProcessIdentity(pid, marker)
  if (!beforeTerm || beforeTerm.startIdentity !== identity.startIdentity) return
  signalUnixProcess(pid, 'SIGTERM')
  const termDeadline = Date.now() + PROCESS_TREE_KILL_GRACE_MS
  while (Date.now() < termDeadline) {
    const current = await readUnixProcessIdentity(pid, marker)
    if (!current || current.startIdentity !== identity.startIdentity) return
    await sleep(PROCESS_TREE_KILL_POLL_MS)
  }
  const current = await readUnixProcessIdentity(pid, marker)
  if (!current || current.startIdentity !== identity.startIdentity) return
  const beforeKill = await readUnixProcessIdentity(pid, marker)
  if (!beforeKill || beforeKill.startIdentity !== identity.startIdentity) return
  signalUnixProcess(pid, 'SIGKILL')
  const killDeadline = Date.now() + PROCESS_TREE_KILL_GRACE_MS
  while (Date.now() < killDeadline) {
    const after = await readUnixProcessIdentity(pid, marker)
    if (!after || after.startIdentity !== identity.startIdentity) return
    await sleep(PROCESS_TREE_KILL_POLL_MS)
  }
  throw new Error(`owned process PID ${pid} remained after SIGKILL`)
}

async function readUnixProcessIdentity(pid: number, marker: string): Promise<OwnedUnixProcess | undefined> {
  if (process.platform === 'linux') {
    const fs = await import('node:fs/promises')
    let stat: string | undefined
    let environ: Buffer | undefined
    try {
      stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
      environ = await fs.readFile(`/proc/${pid}/environ`)
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ESRCH') || isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) return undefined
      throw Object.assign(new Error(`owned process identity snapshot failed for PID ${pid}`), { code: (error as NodeJS.ErrnoException).code })
    }
    if (!stat || !environ) return undefined
    const close = stat.lastIndexOf(')')
    if (close < 0) throw new Error(`owned process identity snapshot was malformed for PID ${pid}`)
    const fields = stat.slice(close + 2).split(' ')
    const startIdentity = fields[19]
    if (!startIdentity) throw new Error(`owned process start identity unavailable for PID ${pid}`)
    const expected = `WRENYARD_EXECUTION_OWNER=${marker}`
    if (!environ.toString('utf8').split('\0').includes(expected)) return undefined
    return { pid, startIdentity }
  }
  if (process.platform === 'darwin') {
    const rows = await runPrivatePsSnapshot()
    const row = rows.find((candidate) => candidate.pid === pid)
    if (!row || !row.environment.split(/\s+/u).includes(`WRENYARD_EXECUTION_OWNER=${marker}`)) return undefined
    return { pid, startIdentity: row.startIdentity }
  }
  throw new Error(`owned process identity is unsupported on ${process.platform}`)
}

async function discoverLinuxMarkerProcesses(marker: string): Promise<OwnedUnixProcess[]> {
  const fs = await import('node:fs/promises')
  const entries = await fs.readdir('/proc').catch((error) => { throw new Error(`owned process snapshot failed: ${errorMessage(error)}`) })
  const found: OwnedUnixProcess[] = []
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue
    const pid = Number(entry)
    if (!isSafeUnixProcessId(pid)) continue
    let stat: import('node:fs').Stats
    try {
      stat = await fs.stat(`/proc/${pid}`)
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ESRCH') || isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) continue
      throw Object.assign(new Error(`owned process snapshot failed (${String((error as NodeJS.ErrnoException).code ?? 'unknown')})`), { code: (error as NodeJS.ErrnoException).code })
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) continue
    const identity = await readUnixProcessIdentity(pid, marker).catch((error) => {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ESRCH') || isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) return undefined
      throw error
    })
    if (identity) found.push(identity)
  }
  return found
}

async function discoverMacMarkerProcesses(marker: string): Promise<OwnedUnixProcess[]> {
  const rows = await runPrivatePsSnapshot()
  const needle = `WRENYARD_EXECUTION_OWNER=${marker}`
  return rows.filter((row) => row.environment.split(/\s+/u).includes(needle))
    .map(({ pid, startIdentity }) => ({ pid, startIdentity }))
}

async function runPrivatePsSnapshot(): Promise<Array<{ pid: number; startIdentity: string; environment: string }>> {
  const { execFile } = await import('node:child_process')
  const output = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-E', '-ww', '-axo', 'pid=,lstart=,command='], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      if (error) reject(new Error(`owned process snapshot failed (${String((error as NodeJS.ErrnoException).code ?? 'unknown')})`))
      else resolve(stdout)
    })
  })
  const rows: Array<{ pid: number; startIdentity: string; environment: string }> = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.{24})\s+(.*)$/u.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    if (isSafeUnixProcessId(pid)) rows.push({ pid, startIdentity: match[2].trim(), environment: match[3] })
  }
  return rows
}

/**
 * Terminate the process tree rooted at `pid`. An explicitly supplied `pgid`
 * targets only that Unix process group; if it is absent, no PID fallback is
 * attempted. Without `pgid`, Unix cleanup retains the root-PID fallback.
 */
export async function killProcessTree(pid: number, pgid?: number): Promise<void> {
  if (!isPositiveInteger(pid)) return

  if (process.platform === 'win32') {
    const outcome = await taskkillProcessTree(pid)
    const commandFailed = outcome.spawnError !== undefined
      || (outcome.code !== null && outcome.code !== 0)

    if (commandFailed) {
      if (!processExists(pid)) return
      const detail = outcome.spawnError !== undefined
        ? `taskkill could not start: ${outcome.spawnError}`
        : `taskkill exited with code ${outcome.code ?? 'unknown'}`
          + (outcome.signal ? ` (signal ${outcome.signal})` : '')
          + (outcome.stderr ? `: ${outcome.stderr}` : '')
      throw new Error(`killProcessTree failed to terminate PID ${pid}: ${detail}`)
    }

    if (await waitForProcessExit(pid, PROCESS_TREE_KILL_GRACE_MS)) return
    throw new Error(`killProcessTree timed out waiting for PID ${pid} to exit after taskkill reported success`)
  }

  if (!isSafeUnixProcessId(pid)) throw new Error(`killProcessTree refused unsafe PID ${pid}`)
  const explicitPgid = pgid !== undefined
  const targetPgid = pgid ?? pid
  if (!isSafeUnixProcessId(targetPgid)) throw new Error(`killProcessTree refused unsafe PGID ${targetPgid}`)

  const termSent = signalUnixProcessGroup(targetPgid, 'SIGTERM')
  if (!termSent) {
    if (explicitPgid) return
    await terminateUnixProcess(pid)
    return
  }

  if (await waitForUnixProcessGroupExit(targetPgid, PROCESS_TREE_KILL_GRACE_MS)) return
  signalUnixProcessGroup(targetPgid, 'SIGKILL')
  if (!(await waitForUnixProcessGroupExit(targetPgid, PROCESS_TREE_KILL_GRACE_MS))) {
    throw new Error(`killProcessTree timed out waiting for process group ${targetPgid} to exit after SIGKILL`)
  }
}

function isSafeUnixProcessId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 1 && value !== process.pid
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

async function terminateUnixProcess(pid: number): Promise<void> {
  if (!signalUnixProcess(pid, 'SIGTERM')) return
  if (await waitForUnixProcessExit(pid, PROCESS_TREE_KILL_GRACE_MS)) return
  signalUnixProcess(pid, 'SIGKILL')
  if (!(await waitForUnixProcessExit(pid, PROCESS_TREE_KILL_GRACE_MS))) {
    throw new Error(`killProcessTree timed out waiting for PID ${pid} to exit after SIGKILL`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForUnixProcessGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!unixProcessGroupExists(pgid)) return true
    await sleep(Math.min(PROCESS_TREE_KILL_POLL_MS, deadline - Date.now()))
  }
  return !unixProcessGroupExists(pgid)
}

function unixProcessGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false
    return true
  }
}

async function waitForUnixProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!unixProcessExists(pid)) return true
    await sleep(Math.min(PROCESS_TREE_KILL_POLL_MS, deadline - Date.now()))
  }
  return !unixProcessExists(pid)
}

function unixProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false
    return true
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false
    return true
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true
    await sleep(Math.min(PROCESS_TREE_KILL_POLL_MS, deadline - Date.now()))
  }
  return !processExists(pid)
}

type TaskkillOutcome = {
  spawnError?: string
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

function taskkillProcessTree(pid: number): Promise<TaskkillOutcome> {
  return new Promise((resolve) => {
    const stderrChunks: Buffer[] = []
    const child = spawnShellProcess('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      timeout: PROCESS_TREE_KILL_GRACE_MS,
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrChunks.length < 64) stderrChunks.push(chunk)
    })

    const settle = (outcome: TaskkillOutcome): void => {
      outcome.stderr = Buffer.concat(stderrChunks).toString('utf8').slice(-1024)
      resolve(outcome)
    }

    child.once('error', (error) => {
      settle({ spawnError: error.message, code: null, signal: null, stderr: '' })
    })
    child.once('close', (code, signal) => {
      settle({ spawnError: undefined, code, signal, stderr: '' })
    })
  })
}

function signalUnixProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false
    throw new Error(`killProcessTree failed to send ${signal} to process group ${pgid}: ${errorMessage(error)}`)
  }
}

function signalUnixProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false
    throw new Error(`killProcessTree failed to send ${signal} to PID ${pid}: ${errorMessage(error)}`)
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
