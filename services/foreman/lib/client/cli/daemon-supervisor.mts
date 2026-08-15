import { execFileSync, spawn } from 'node:child_process'
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
import { foremanStateRoot } from '../../config/state.mts'
import { connectIpcForemanClient } from '../ipc-foreman-client.mts'
import type { ForemanServiceConfig } from '../../config/index.mts'
import { resolveForemanServiceIpcPath } from '../../transport/ipc-server.mts'
import { resolveDependencyPackageRoot } from '../../layout/suite-root.mts'
import {
  errorMessage,
  foremanDir,
  isIpcReachable,
  localForemanServiceOriginForConfig,
  sleep,
  waitForIpcReachable,
  waitForIpcUnreachable,
} from './shared.mts'

const STATE_VERSION = 1
const STARTUP_TIMEOUT_MS = 15_000
const SHUTDOWN_TIMEOUT_MS = 5_000

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
    await terminateDaemonPid(stalePid)
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
  }
  writeDaemonState(paths, state)

  try {
    await waitForIpcReachable(ipcPath, STARTUP_TIMEOUT_MS)
  } catch (error) {
    await terminateDaemonPid(childPid)
    clearDaemonState(paths)
    const detail = errorMessage(error)
    throw new Error(`Wrenyard daemon process started but did not become reachable over IPC. ${detail}`)
  }

  return {
    pid: childPid,
    ipcPath,
    httpUrl,
    statePath: paths.statePath,
    logPaths: paths.logPaths,
  }
}

export async function stopDaemonProcess(options: DaemonLifecycleOptions): Promise<DaemonLifecycleResult> {
  const paths = resolveDaemonSupervisorPaths()
  const ipcPath = resolveForemanServiceIpcPath({
    port: options.config.service.port,
    path: options.config.service.ipc?.path,
  })
  const httpUrl = localForemanServiceOriginForConfig(options.config)
  const state = readDaemonState(paths)
  const pid = readDaemonPid(paths) ?? state?.pid
  let graceful = false
  let forced = false

  try {
    const client = await connectIpcForemanClient({ path: ipcPath, timeoutMs: 1_000 })
    try {
      await client.daemon.shutdown({ reason: 'wrenyard daemon stop' })
      graceful = true
    } finally {
      client.close()
    }
  } catch {
    // If IPC is already gone, stop falls back to the state PID below.
  }

  await waitForIpcUnreachable(ipcPath, SHUTDOWN_TIMEOUT_MS)

  if (pid && isProcessAlive(pid)) {
    await terminateDaemonPid(pid)
    forced = true
  }
  if (await isIpcReachable(ipcPath)) {
    throw new Error(`Wrenyard daemon IPC is still reachable at ${ipcPath} after shutdown`)
  }

  clearDaemonState(paths)
  return {
    ...(pid ? { pid } : {}),
    ipcPath,
    httpUrl,
    statePath: paths.statePath,
    logPaths: paths.logPaths,
    graceful,
    forced,
  }
}

export interface RestartDaemonProcessHooks {
  /** Invoked exactly once, after the running daemon has stopped and before the
   * new daemon is started. Awaiting this hook lets a caller durably mark the
   * restart boundary (for example, persist the `starting` phase) at the real
   * stop/start transition rather than guessing its timing. */
  onStopped?: () => void | Promise<void>
}

export async function restartDaemonProcess(
  options: DaemonLifecycleOptions,
  hooks?: RestartDaemonProcessHooks,
): Promise<DaemonLifecycleResult> {
  await stopDaemonProcess(options)
  if (hooks?.onStopped) await hooks.onStopped()
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
    join(foremanDir, 'bin', 'foreman-deamon.mts'),
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

async function terminateDaemonPid(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Fall through to the hard stop path if the process still exists.
  }

  if (await waitForProcessExit(pid, SHUTDOWN_TIMEOUT_MS)) return

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      })
    } catch {
      // Best effort. The final wait below decides whether it worked.
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Best effort.
    }
  }

  await waitForProcessExit(pid, 2_000)
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(100)
  }
  return !isProcessAlive(pid)
}
