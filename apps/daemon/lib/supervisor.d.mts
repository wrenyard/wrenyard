import type { ChildProcess, StdioOptions } from 'node:child_process'

export interface DaemonProcessExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  expected: boolean
}

export interface DaemonProcessOptions {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  ipcPath: string
  readyTimeoutMs?: number
  pollIntervalMs?: number
  stopTimeoutMs?: number
  exitPollMs?: number
  probe?: () => Promise<boolean>
  onExit?: (info: DaemonProcessExitInfo) => void
  stdio?: StdioOptions
}

/** One NDJSON JSON-RPC call through the shared version-checked control client;
 *  the client is closed after the call and the first request runs the
 *  `health.ping` protocol-version handshake. */
export function ipcCall(
  ipcPath: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown>

/** True when the daemon answers `health.ping` with `ok: true` on `ipcPath`. */
export function isDaemonHealthy(ipcPath: string, timeoutMs?: number): Promise<boolean>

export class DaemonProcess {
  constructor(options: DaemonProcessOptions)
  readonly pid: number | undefined
  readonly child: ChildProcess | null
  readonly running: boolean
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  /** Spawn and resolve once ready; a failed start terminates the child and
   *  rejects without emitting `onExit`. */
  launch(): Promise<void>
  /** Graceful `daemon.shutdown` RPC then awaited exit; `force` escalates to
   *  cancellation plus SIGKILL. The owned Node IPC channel is a fallback when
   *  the RPC transport is unavailable. */
  shutdown(options?: { force?: boolean; timeoutMs?: number }): Promise<boolean>
  kill(): Promise<void>
  waitForExit(timeoutMs: number): Promise<boolean>
  release(): void
}
