import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'

const PROCESS_TREE_KILL_GRACE_MS = 10_000
const PROCESS_TREE_KILL_POLL_MS = 100

export function spawnShellProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, args, {
    ...options,
    windowsHide: resolveWindowsHideOption(options),
  })
}

export function resolveWindowsHideOption(options: { windowsHide?: boolean }): boolean | undefined {
  return options.windowsHide ?? (process.platform === 'win32' ? true : undefined)
}

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

  const targetPgid = pgid ?? pid
  if (!isPositiveInteger(targetPgid)) return

  const termSent = signalUnixProcessGroup(targetPgid, 'SIGTERM')
  if (!termSent) {
    const pidTermSent = signalUnixProcess(pid, 'SIGTERM')
    if (!pidTermSent) return
    if (await waitForUnixProcessExit(pid, PROCESS_TREE_KILL_GRACE_MS)) return
    signalUnixProcess(pid, 'SIGKILL')
    await waitForUnixProcessExit(pid, PROCESS_TREE_KILL_GRACE_MS)
    return
  }

  if (await waitForUnixProcessGroupExit(targetPgid, PROCESS_TREE_KILL_GRACE_MS)) return
  signalUnixProcessGroup(targetPgid, 'SIGKILL')
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
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
    console.warn(`[foreman] Failed to send ${signal} to process group ${pgid}: ${errorMessage(error)}`)
    return false
  }
}

function signalUnixProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false
    console.warn(`[foreman] Failed to send ${signal} to process ${pid}: ${errorMessage(error)}`)
    return false
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
