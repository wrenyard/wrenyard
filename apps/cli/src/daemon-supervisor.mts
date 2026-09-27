import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { foremanStateRoot } from '@wrenyard/daemon/config/state'
import { connectIpcForemanClient } from '@wrenyard/daemon/control/ipc-client'
import type { ForemanServiceConfig } from '@wrenyard/daemon/config'
import { resolveForemanServiceIpcPath } from '@wrenyard/daemon/control/ipc-server'
import { readSuiteVersion, resolveDependencyPackageRoot } from '@wrenyard/daemon/layout/suite-root'
import { readLiveInstanceLock } from '@wrenyard/daemon/daemon/instance-lock'
import {
  errorMessage,
  foremanDir,
  isIpcReachable,
  localForemanServiceOriginForConfig,
  sleep,
  suiteDir,
  waitForIpcReachable,
} from './shared.mts'
import { readSourceDevLock, sourceDevLockRefusalMessage } from './source-dev-lock.mts'

const STATE_VERSION = 1
const STARTUP_TIMEOUT_MS = 15_000
const ACTIVE_COUNT_NOTICE_MS = 10_000

export interface DaemonLogPaths {
  stdout: string
  stderr: string
}

export interface DaemonState {
  version: number
  pid: number
  startedAt: string
  configPath: string
  ipcPath: string
  httpUrl: string
  command: string
  args: string[]
  cwd: string
  logPaths: DaemonLogPaths
  /** Authoritative installed suite root that launched this daemon. */
  suiteRoot?: string
  /** Package version of the installed suite that launched this daemon. */
  suiteVersion?: string
}

export interface DaemonSupervisorPaths {
  stateDir: string
  pidPath: string
  statePath: string
  logPaths: DaemonLogPaths
}

export interface DaemonLifecycleOptions {
  config: ForemanServiceConfig
  resolvedConfigPath: string
  cliValues?: Record<string, unknown>
  shutdownForce?: boolean
}

export interface DaemonLifecycleResult {
  pid?: number
  ipcPath: string
  httpUrl: string
  statePath: string
  logPaths: DaemonLogPaths
  alreadyRunning?: boolean
  graceful?: boolean
  forced?: boolean
}

export interface DaemonSupervisorStatus {
  running: boolean
  status: 'running' | 'stopped' | 'unhealthy' | 'stale'
  process: 'wrenyard-daemon'
  pid?: number
  pidAlive: boolean
  statePath: string
  pidPath: string
  state?: DaemonState
  logPaths: DaemonLogPaths
  ipcPath: string
  httpUrl: string
}

export function resolveDaemonSupervisorPaths(): DaemonSupervisorPaths {
  const stateDir = resolveForemanStateDir()
  return {
    stateDir,
    pidPath: join(stateDir, 'wrenyard-daemon.pid'),
    statePath: join(stateDir, 'wrenyard-daemon.json'),
    logPaths: {
      stdout: join(stateDir, 'logs', 'wrenyard-out.log'),
      stderr: join(stateDir, 'logs', 'wrenyard-error.log'),
    },
  }
}

export function resolveForemanStateDir(): string {
  return foremanStateRoot()
}

export async function startDaemonProcess(options: DaemonLifecycleOptions): Promise<DaemonLifecycleResult> {
  // A live `pnpm dev` owns the daemon and restarts it on source changes; a
  // second daemon would fight it for the IPC path, so refuse before spawning.
  const devLock = readSourceDevLock()
  if (devLock) throw new Error(sourceDevLockRefusalMessage(devLock))

  const paths = resolveDaemonSupervisorPaths()
  const ipcPath = resolveForemanServiceIpcPath({
    port: options.config.service.port,
    path: options.config.service.ipc?.path,
  })
  const httpUrl = localForemanServiceOriginForConfig(options.config)

  mkdirSync(paths.stateDir, { recursive: true })
  mkdirSync(join(paths.stateDir, 'logs'), { recursive: true })

  const existingState = readDaemonState(paths)
  if (await isIpcReachable(ipcPath)) {
    if (existingState && existingState.ipcPath === ipcPath && isProcessAlive(existingState.pid)) {
      return {
        pid: existingState.pid,
        ipcPath,
        httpUrl,
        statePath: paths.statePath,
        logPaths: paths.logPaths,
        alreadyRunning: true,
      }
    }
    return {
      ipcPath,
      httpUrl,
      statePath: paths.statePath,
      logPaths: paths.logPaths,
      alreadyRunning: true,
    }
  }

  const stalePid = readDaemonPid(paths) ?? existingState?.pid
  if (stalePid && isProcessAlive(stalePid)) {
    throw new Error(`Wrenyard daemon pid ${stalePid} is alive but IPC is unreachable; inspect it before starting another daemon`)
  }
  clearDaemonState(paths)

  const invocation = buildDaemonInvocation(options)
  const stdoutFd = openSync(paths.logPaths.stdout, 'a')
  const stderrFd = openSync(paths.logPaths.stderr, 'a')
  let childPid: number | undefined
  try {
    const child = spawn(invocation.command, invocation.args, {
      cwd: foremanDir,
      env: {
        ...process.env,
        WRENYARD_CONFIG: options.resolvedConfigPath,
        WRENYARD_HOST: options.config.service.host,
        WRENYARD_PORT: String(options.config.service.port),
      },
      detached: true,
      shell: false,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    })
    childPid = child.pid
    if (!childPid) throw new Error('daemon process did not expose a pid')
    child.unref()
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }

  const identity = suiteIdentity()
  const state: DaemonState = {
    version: STATE_VERSION,
    pid: childPid,
    startedAt: new Date().toISOString(),
    configPath: options.resolvedConfigPath,
    ipcPath,
    httpUrl,
    command: invocation.command,
    args: invocation.args,
    cwd: foremanDir,
    logPaths: paths.logPaths,
    suiteRoot: identity.suiteRoot,
    suiteVersion: identity.suiteVersion,
  }
  writeDaemonState(paths, state)

  try {
    await waitForIpcReachable(ipcPath, STARTUP_TIMEOUT_MS)
  } catch (error) {
    const detail = errorMessage(error)
    throw new Error(`Wrenyard daemon pid ${childPid} did not become reachable over IPC. ${detail}. Its state is retained for inspection.`)
  }

  return {
    pid: childPid,
    ipcPath,
    httpUrl,
    statePath: paths.statePath,
    logPaths: paths.logPaths,
  }
}

/**
 * Narrow IPC surface the stop path needs. Kept structural so focused tests can
 * inject a recording client without ever touching a real daemon.
 */
export interface DaemonStopClient {
  daemon: {
    shutdown(params: { reason: string; force: boolean }): Promise<unknown>
  }
  close(): void
}

/** Overridable collaborators for {@link stopDaemonProcess}. */
export interface DaemonStopHooks {
  isIpcReachable?: (ipcPath: string) => Promise<boolean>
  connectIpc?: (options: { path: string; timeoutMs: number }) => Promise<DaemonStopClient>
  isProcessAlive?: (pid: number) => boolean
  readLiveLock?: (path: string) => unknown
  sleep?: (ms: number) => Promise<void>
}

export async function stopDaemonProcess(
  options: DaemonLifecycleOptions,
  hooks: DaemonStopHooks = {},
): Promise<DaemonLifecycleResult> {
  const paths = resolveDaemonSupervisorPaths()
  const ipcPath = resolveForemanServiceIpcPath({
    port: options.config.service.port,
    path: options.config.service.ipc?.path,
  })
  const httpUrl = localForemanServiceOriginForConfig(options.config)
  const state = readDaemonState(paths)
  const pid = readDaemonPid(paths) ?? state?.pid
  const isReachable: (ipcPath: string) => Promise<boolean> = hooks.isIpcReachable ?? isIpcReachable
  const connect: (options: { path: string; timeoutMs: number }) => Promise<DaemonStopClient> =
    hooks.connectIpc ?? connectIpcForemanClient
  const alive: (pid: number) => boolean = hooks.isProcessAlive ?? isProcessAlive
  const liveLock: (path: string) => unknown = hooks.readLiveLock ?? readLiveInstanceLock
  const delay: (ms: number) => Promise<void> = hooks.sleep ?? sleep

  const reachable = await isReachable(ipcPath)
  if (reachable) {
    const client = await connect({ path: ipcPath, timeoutMs: 1_000 })
    try {
      await client.daemon.shutdown({ reason: 'wrenyard daemon stop', force: options.shutdownForce === true })
    } finally {
      client.close()
    }
  } else if (pid && alive(pid)) {
    throw new Error(`Wrenyard daemon pid ${pid} is alive but IPC is unreachable; graceful shutdown could not be requested`)
  }

  // The daemon owns its drain and exit. An active job may keep it alive for as
  // long as needed; the caller never converts a slow shutdown into a kill.
  // Active counts are printed to stderr every 10s so a `--json` restart keeps
  // stdout as one clean machine-readable envelope.
  const reporter = startActiveCountReporter(ipcPath)
  try {
    while (pid && alive(pid)) await delay(200)
    while (await isReachable(ipcPath)) await delay(200)
    // The daemon removes daemon.lock as its final act; wait for it without a
    // deadline so a slow drain is never cut short.
    const lockPath = join(paths.stateDir, 'daemon.lock')
    while (liveLock(lockPath)) await delay(200)
  } finally {
    reporter.stop()
  }

  clearDaemonState(paths)
  return {
    ...(pid ? { pid } : {}),
    ipcPath,
    httpUrl,
    statePath: paths.statePath,
    logPaths: paths.logPaths,
    graceful: reachable,
    forced: false,
  }
}

/**
 * Prints the daemon's active-work counts every 10 seconds while a stop drains.
 * Progress goes to stderr so a `--json` restart keeps stdout as a single
 * machine-readable envelope. Queries that fail because the daemon already
 * stopped are ignored; the stop owns the outcome.
 */
function startActiveCountReporter(ipcPath: string): { stop: () => void } {
  const tick = async (): Promise<void> => {
    let client: Awaited<ReturnType<typeof connectIpcForemanClient>> | undefined
    try {
      client = await connectIpcForemanClient({ path: ipcPath, timeoutMs: 1_000 })
      const status = await client.daemon.status()
      process.stderr.write(`Active tasks: ${status.activeTaskCount}, workflows: ${status.activeWorkflowCount}, executions: ${status.activeExecutionCount}\n`)
    } catch {
      // The daemon may already be stopping; the stop owns the outcome.
    } finally {
      client?.close()
    }
  }
  const timer = setInterval(() => { void tick() }, ACTIVE_COUNT_NOTICE_MS)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

/**
 * Synchronous restart: stop the running daemon (waits for its own drain), then
 * start a new one in this process. No detached coordinator or durable plan is
 * involved; the caller observes the whole stop/start transition.
 */
export async function restartDaemonProcess(
  options: DaemonLifecycleOptions,
  hooks: DaemonStopHooks = {},
): Promise<DaemonLifecycleResult> {
  await stopDaemonProcess(options, hooks)
  return startDaemonProcess(options)
}

export async function readDaemonSupervisorStatus(options: DaemonLifecycleOptions): Promise<DaemonSupervisorStatus> {
  const paths = resolveDaemonSupervisorPaths()
  const ipcPath = resolveForemanServiceIpcPath({
    port: options.config.service.port,
    path: options.config.service.ipc?.path,
  })
  const httpUrl = localForemanServiceOriginForConfig(options.config)
  const state = readDaemonState(paths)
  const pid = readDaemonPid(paths) ?? state?.pid
  const pidAlive = pid ? isProcessAlive(pid) : false
  const ipcHealthy = await isIpcReachable(ipcPath)
  const status = ipcHealthy
    ? 'running'
    : pidAlive
      ? 'unhealthy'
      : state || pid
        ? 'stale'
        : 'stopped'

  return {
    running: ipcHealthy,
    status,
    process: 'wrenyard-daemon',
    ...(pid ? { pid } : {}),
    pidAlive,
    statePath: paths.statePath,
    pidPath: paths.pidPath,
    ...(state ? { state } : {}),
    logPaths: paths.logPaths,
    ipcPath,
    httpUrl,
  }
}

export function buildDaemonInvocation(options: DaemonLifecycleOptions): { command: string; args: string[] } {
  const tsxPackageRoot = resolveDependencyPackageRoot(foremanDir, 'tsx')
  const preflightPath = join(tsxPackageRoot, 'dist', 'preflight.cjs')
  const loaderPath = join(tsxPackageRoot, 'dist', 'loader.mjs')
  if (!existsSync(preflightPath) || !existsSync(loaderPath)) {
    throw new Error('Local tsx loader files were not found. Run pnpm install at the Wrenyard suite root.')
  }

  const args = [
    '--require',
    preflightPath,
    '--import',
    pathToFileURL(loaderPath).href,
    join(foremanDir, 'bin', 'daemon.mts'),
    '--config',
    options.resolvedConfigPath,
  ]
  appendStringOverride(args, '--host', options.cliValues?.host)
  appendStringOverride(args, '--port', options.cliValues?.port)
  appendStringOverride(args, '--public-url', options.cliValues?.['public-url'])
  appendStringOverride(args, '--work-dir', options.cliValues?.['work-dir'])
  return {
    command: process.execPath,
    args,
  }
}

function appendStringOverride(args: string[], flag: string, value: unknown): void {
  if (typeof value === 'string' && value.trim()) {
    args.push(flag, value)
  }
}

function suiteIdentity(): { suiteRoot: string; suiteVersion: string } {
  return { suiteRoot: suiteDir, suiteVersion: readSuiteVersion(suiteDir) }
}

function readDaemonPid(paths = resolveDaemonSupervisorPaths()): number | undefined {
  try {
    const raw = readFileSync(paths.pidPath, 'utf-8').trim()
    const pid = Number(raw)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function readDaemonState(paths = resolveDaemonSupervisorPaths()): DaemonState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(paths.statePath, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const state = parsed as Partial<DaemonState>
    if (typeof state.pid !== 'number' || !Number.isInteger(state.pid) || state.pid <= 0) return undefined
    if (typeof state.ipcPath !== 'string') return undefined
    if (typeof state.httpUrl !== 'string') return undefined
    return state as DaemonState
  } catch {
    return undefined
  }
}

function writeDaemonState(paths: DaemonSupervisorPaths, state: DaemonState): void {
  mkdirSync(paths.stateDir, { recursive: true })
  writeFileSync(paths.pidPath, `${state.pid}\n`, 'utf-8')
  writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
}

function clearDaemonState(paths = resolveDaemonSupervisorPaths()): void {
  rmSync(paths.pidPath, { force: true })
  rmSync(paths.statePath, { force: true })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}
