import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveRuntimeBin } from '../layout/runtime-bin.mts'
import { killProcessTree } from '../adapters/shell/process.mts'
import type { ForemanPetConfig } from '../config/index.mts'
import { writeForemanPetEnabled } from '../config/index.mts'
import { foremanStateRoot } from '../config/state.mts'

const execFileAsync = promisify(execFile)
const PET_RUNTIME_STATE_VERSION = 1
const HIDDEN_EXEC_OPTIONS: ExecFileOptions = { windowsHide: true }

export type PetLifecycleState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

export interface PetStatus {
  state: PetLifecycleState
  enabled: boolean
  running: boolean
  transport: 'ipc-jsonrpc'
  command: string
  args: string[]
  cwd: string
  ipc_path?: string
  pid?: number
  started_at?: string
  stopped_at?: string
  last_error?: string
  last_exit_code?: number
  last_exit_signal?: string
}

export interface PetStartOptions {
  persist?: boolean
}

export interface PetStopOptions {
  persist?: boolean
}

export interface PetRestartOptions {
  persist?: boolean
}

export interface PetServiceLogger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

export type PetSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess
export type PetBuild = (cwd: string) => Promise<void>

export interface PetSpawnCommand {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

export interface ForemanPetServiceOptions {
  config: ForemanPetConfig
  configPath?: string
  foremanIpcPath?: string
  stateRoot?: string
  logger?: PetServiceLogger
  spawnProcess?: PetSpawn
  buildPet?: PetBuild
  now?: () => Date
}

interface PetRuntimeState {
  version: number
  pid: number
  pgid?: number
  startedAt: string
  command: string
  args: string[]
  cwd: string
  ipcPath?: string
}

export interface PetRuntimePaths {
  stateDir: string
  pidPath: string
  statePath: string
}

export class ForemanPetService {
  private readonly config: ForemanPetConfig
  private readonly configPath: string | undefined
  private readonly logger: PetServiceLogger
  private readonly spawnProcess: PetSpawn
  private readonly buildPet: PetBuild
  private readonly now: () => Date
  private readonly runtimePaths: PetRuntimePaths
  private child: ChildProcess | undefined
  private foremanIpcPath: string | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private state: PetLifecycleState = 'stopped'
  private startedAt: string | undefined
  private stoppedAt: string | undefined
  private lastError: string | undefined
  private lastExitCode: number | undefined
  private lastExitSignal: string | undefined
  private stopping = false

  constructor(options: ForemanPetServiceOptions) {
    this.config = options.config
    this.configPath = options.configPath
    this.foremanIpcPath = options.foremanIpcPath
    this.logger = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    this.spawnProcess = options.spawnProcess ?? spawn
    this.buildPet = options.buildPet ?? buildPetApp
    this.now = options.now ?? (() => new Date())
    this.runtimePaths = petRuntimePaths(options.stateRoot)
  }

  setForemanIpcPath(path: string): void {
    this.foremanIpcPath = path
  }

  async start(options: PetStartOptions = {}): Promise<void> {
    const persist = options.persist !== false
    if (persist) this.persistEnabled(true)

    if (this.isChildRunning()) {
      this.state = 'running'
      return
    }

    this.clearRestartTimer()
    try {
      this.assertLaunchConfig()
    } catch (error) {
      this.state = 'failed'
      this.lastError = errorMessage(error)
      this.logger.error('wrenyard pet child startup failed', error)
      throw error
    }
    this.state = 'starting'
    this.lastError = undefined
    this.lastExitCode = undefined
    this.lastExitSignal = undefined
    this.stopping = false
    await this.stopManagedRuntime()

    const resolvedSpawn = resolvePetSpawnCommand(
      this.config.command,
      this.config.args,
      process.platform,
      this.config.cwd,
    )
    const child = this.spawnProcess(resolvedSpawn.command, resolvedSpawn.args, {
      cwd: this.config.cwd,
      env: this.childEnv(),
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
      ...(resolvedSpawn.windowsVerbatimArguments !== undefined
        ? { windowsVerbatimArguments: resolvedSpawn.windowsVerbatimArguments }
        : {}),
    })
    this.child = child

    try {
      await this.waitForStartup(child)
      this.startedAt = this.isoNow()
      this.stoppedAt = undefined
      this.state = 'running'
      this.writeRuntimeState(child, this.startedAt)
      this.logger.info('wrenyard pet child started', {
        pid: child.pid,
        cwd: this.config.cwd,
        command: this.config.command,
        transport: 'ipc-jsonrpc',
      })
    } catch (error) {
      if (child.exitCode === null && !child.killed) {
        await this.terminateChild(child).catch(() => {})
      }
      this.clearRuntimeState()
      this.child = undefined
      this.state = 'failed'
      this.lastError = errorMessage(error)
      this.logger.error('wrenyard pet child startup failed', error)
      throw error
    }
  }

  async stop(options: PetStopOptions = {}): Promise<void> {
    const persist = options.persist !== false
    if (persist) this.persistEnabled(false)

    this.clearRestartTimer()
    const child = this.child
    if (!child || !this.isChildRunning()) {
      this.child = undefined
      await this.stopManagedRuntime()
      this.state = 'stopped'
      this.stoppedAt = this.isoNow()
      return
    }

    this.state = 'stopping'
    this.stopping = true
    try {
      await this.terminateChild(child)
      this.clearRuntimeState()
      this.child = undefined
      this.state = 'stopped'
      this.stoppedAt = this.isoNow()
      this.logger.info('wrenyard pet child stopped')
    } catch (error) {
      this.state = 'failed'
      this.lastError = errorMessage(error)
      this.logger.error('wrenyard pet child shutdown failed', error)
      throw error
    } finally {
      this.stopping = false
    }
  }

  async restart(options: PetRestartOptions = {}): Promise<void> {
    // Build while the current pet is still running. A failed build must not
    // replace a healthy process with stale or incomplete artifacts.
    await this.buildPet(this.config.cwd)
    await this.stop({ persist: false })
    await this.start({ persist: options.persist !== false })
  }

  status(): PetStatus {
    return {
      state: this.state,
      enabled: this.config.enabled,
      running: this.isChildRunning() && this.state === 'running',
      transport: 'ipc-jsonrpc',
      command: this.config.command,
      args: [...this.config.args],
      cwd: this.config.cwd,
      ...(this.foremanIpcPath ? { ipc_path: this.foremanIpcPath } : {}),
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.startedAt ? { started_at: this.startedAt } : {}),
      ...(this.stoppedAt ? { stopped_at: this.stoppedAt } : {}),
      ...(this.lastError ? { last_error: this.lastError } : {}),
      ...(this.lastExitCode !== undefined ? { last_exit_code: this.lastExitCode } : {}),
      ...(this.lastExitSignal ? { last_exit_signal: this.lastExitSignal } : {}),
    }
  }

  private persistEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    if (!this.configPath) return
    writeForemanPetEnabled(this.configPath, enabled)
  }

  private assertLaunchConfig(): void {
    if (!this.config.command.trim()) {
      throw new Error('pet.command is required')
    }
    if (!existsSync(this.config.cwd)) {
      throw new Error(`pet.cwd does not exist: ${this.config.cwd}`)
    }
    const packageJsonPath = join(this.config.cwd, 'package.json')
    if (!existsSync(packageJsonPath) || !statSync(packageJsonPath).isFile()) {
      throw new Error(`pet.cwd must contain a package.json file: ${packageJsonPath}`)
    }
    if (!this.foremanIpcPath) {
      throw new Error('wrenyard IPC path is not available for pet')
    }
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      WRENYARD_PET_MANAGED: '1',
      WRENYARD_IPC_PATH: this.foremanIpcPath,
      WRENYARD_RUNTIME_BIN: resolveRuntimeBin(process.env),
    }
  }

  private waitForStartup(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      let stableTimer: NodeJS.Timeout | undefined
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`pet child did not spawn within ${this.config.startupTimeoutMs}ms`))
      }, this.config.startupTimeoutMs)

      const cleanup = (): void => {
        clearTimeout(timeout)
        if (stableTimer) clearTimeout(stableTimer)
        child.off('spawn', handleSpawn)
        child.off('error', handleError)
        child.off('exit', handleEarlyExit)
      }
      const handleSpawn = (): void => {
        clearTimeout(timeout)
        stableTimer = setTimeout(() => {
          cleanup()
          child.once('exit', (code, signal) => {
            this.handleChildExit(child, code, signal)
          })
          resolve()
        }, this.startupStableDelayMs())
      }
      const handleError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const handleEarlyExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup()
        reject(new Error(`pet child exited during startup: ${exitDescription(code, signal)}`))
      }

      child.once('spawn', handleSpawn)
      child.once('error', handleError)
      child.once('exit', handleEarlyExit)
    })
  }

  private startupStableDelayMs(): number {
    return Math.max(0, Math.min(this.config.startupTimeoutMs, this.config.restartDelayMs, 1_000))
  }

  private handleChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.lastExitCode = code ?? undefined
    this.lastExitSignal = signal ?? undefined
    this.child = undefined
    this.stoppedAt = this.isoNow()
    this.clearRuntimeState()

    if (this.stopping) return

    this.state = this.config.enabled ? 'failed' : 'stopped'
    if (this.config.enabled && this.config.restartOnExit) {
      this.logger.warn('wrenyard pet child exited; scheduling restart', {
        code,
        signal,
        delayMs: this.config.restartDelayMs,
      })
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined
        void this.start({ persist: false }).catch((error) => {
          this.state = 'failed'
          this.lastError = errorMessage(error)
          this.logger.error('wrenyard pet child restart failed', error)
        })
      }, this.config.restartDelayMs)
    }
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    const pid = child.pid
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })

    if (pid === undefined) {
      child.kill()
      await exited
      return
    }

    if (process.platform === 'win32') {
      try {
        await taskkillPetTree(pid)
      } catch {
        child.kill()
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }

    await withTimeout(exited, this.config.stopTimeoutMs, async () => {
      if (process.platform === 'win32') {
        try {
          await taskkillPetTree(pid)
        } catch { /* ignore */ }
      } else {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
        }
      }
    })
  }

  private async stopManagedRuntime(): Promise<void> {
    const state = this.readRuntimeState()
    const pid = state?.pid ?? this.readRuntimePid()
    if (pid && isProcessAlive(pid)) {
      await killProcessTree(pid, state?.pgid)
    }
    this.clearRuntimeState()
  }

  private isChildRunning(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }

  private isoNow(): string {
    return this.now().toISOString()
  }

  private writeRuntimeState(child: ChildProcess, startedAt: string): void {
    if (!child.pid) return
    const pgid = process.platform === 'win32' ? undefined : child.pid
    const state: PetRuntimeState = {
      version: PET_RUNTIME_STATE_VERSION,
      pid: child.pid,
      ...(pgid ? { pgid } : {}),
      startedAt,
      command: this.config.command,
      args: [...this.config.args],
      cwd: this.config.cwd,
      ...(this.foremanIpcPath ? { ipcPath: this.foremanIpcPath } : {}),
    }

    mkdirSync(this.runtimePaths.stateDir, { recursive: true })
    writeFileSync(this.runtimePaths.pidPath, `${child.pid}\n`, 'utf-8')
    writeFileSync(this.runtimePaths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  }

  private readRuntimeState(): PetRuntimeState | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.runtimePaths.statePath, 'utf-8')) as Partial<PetRuntimeState>
      if (parsed.version !== PET_RUNTIME_STATE_VERSION || !isPositiveInteger(parsed.pid)) return undefined
      return {
        version: PET_RUNTIME_STATE_VERSION,
        pid: parsed.pid,
        ...(isPositiveInteger(parsed.pgid) ? { pgid: parsed.pgid } : {}),
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        command: typeof parsed.command === 'string' ? parsed.command : this.config.command,
        args: Array.isArray(parsed.args) ? parsed.args.map(String) : [...this.config.args],
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : this.config.cwd,
        ...(typeof parsed.ipcPath === 'string' ? { ipcPath: parsed.ipcPath } : {}),
      }
    } catch {
      return undefined
    }
  }

  private readRuntimePid(): number | undefined {
    try {
      const pid = Number(readFileSync(this.runtimePaths.pidPath, 'utf-8').trim())
      return isPositiveInteger(pid) ? pid : undefined
    } catch {
      return undefined
    }
  }

  private clearRuntimeState(): void {
    rmSync(this.runtimePaths.pidPath, { force: true })
    rmSync(this.runtimePaths.statePath, { force: true })
  }
}

export function petRuntimePaths(stateRoot?: string): PetRuntimePaths {
  const stateDir = stateRoot ?? resolveDefaultPetStateDir()
  return {
    stateDir,
    pidPath: join(stateDir, 'pet.pid'),
    statePath: join(stateDir, 'pet.json'),
  }
}

/**
 * Default Pet runtime state lives under the XDG Wrenyard state root so the
 * daemon keeps its pid/json there; explicit stateRoot overrides it.
 */
function resolveDefaultPetStateDir(): string {
  return join(foremanStateRoot(), 'pet')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void | Promise<void>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void Promise.resolve(onTimeout()).finally(() => {
            reject(new Error(`operation timed out after ${timeoutMs}ms`))
          })
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `code ${code}`
  if (signal) return `signal ${signal}`
  return 'unknown exit'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value > 0
}

function taskkillPetTree(pid: number): ReturnType<typeof execFileAsync> {
  return execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f'], HIDDEN_EXEC_OPTIONS)
}

async function buildPetApp(cwd: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'npm run build'], {
      cwd,
      windowsHide: true,
    })
    return
  }
  await execFileAsync('npm', ['run', 'build'], { cwd })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Resolve the last path segment of a command, treating both / and \ as
 * separators so Windows full paths like C:\Program Files\nodejs\npm.cmd
 * resolve their basename correctly regardless of host platform.
 */
function basenameOf(command: string): string {
  const normalized = command.replace(/[\\/]+/gu, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

/**
 * Quote a single argument for inclusion in a cmd.exe /c command-line string.
 * Wraps in double quotes and escapes embedded double quotes when the arg is
 * empty, contains whitespace, a double-quote, or any cmd metacharacter.
 */
function quoteForCmd(arg: string): string {
  if (
    arg.length === 0 ||
    /[\s"&<>()@^|%!;=~`{}[\]]/u.test(arg)
  ) {
    return `"${arg.replace(/"/g, '\\"')}"`
  }
  return arg
}

/**
 * Resolve the actual spawn command and arguments for a pet child process,
 * applying a Windows launch adapter when the host platform is win32.
 *
 * On non-win32 platforms the command/args are returned unchanged. On win32:
 *   - .exe commands are left unchanged.
 *   - .cmd, .bat, and extensionless commands (npm, npx, yarn shims) are
 *     run through cmd.exe /d /s /c with all parts joined into one command-line
 *     string and each argument individually quoted as needed.
 *   - Other extensions are returned unchanged.
 */
export function resolvePetSpawnCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): PetSpawnCommand {
  if (platform !== 'win32') {
    return { command, args }
  }

  const ext = extname(command).toLowerCase()

  // Leave .exe commands unchanged
  if (ext === '.exe') {
    return { command, args }
  }

  // npm start shims with a Foreman foreground script -> launch through node
  // directly, avoiding the black cmd.exe console window on restart.
  if (
    (ext === '' || ext === '.cmd' || ext === '.bat') &&
    /^npm(?:\.cmd|\.bat)?$/u.test(basenameOf(command)) &&
    args.length === 1 &&
    args[0] === 'start' &&
    cwd &&
    existsSync(join(cwd, 'scripts', 'run-foreground.mjs'))
  ) {
    return {
      command: process.execPath,
      args: [join(cwd, 'scripts', 'run-foreground.mjs')],
    }
  }

  // .cmd, .bat, or no-extension shims -> run via cmd.exe
  if (ext === '.cmd' || ext === '.bat' || ext === '') {
    const rawCmdLine = [command, ...args].map(quoteForCmd).join(' ')
    const cmdLine = rawCmdLine.startsWith('"') ? `"${rawCmdLine}"` : rawCmdLine
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', cmdLine],
      windowsVerbatimArguments: true,
    }
  }

  // Other extensions - pass through unchanged
  return { command, args }
}
