/**
 * Bounded, non-inference access to Forge's authoritative client readiness.
 *
 * The child runs exactly `forge doctor clients --json`. Only the public
 * `{id: {enabled, installed}}` projection of the `clients` adapter check
 * details is retained; benign additional fields are ignored and no credential,
 * token, path, stderr, or raw response is returned through this module.
 *
 * This deliberately does NOT invoke the full doctor target or
 * InstalledClientDiscovery: the full doctor runs unrelated checkers, while the
 * UI-surface discovery only supports a subset of clients and probes expensive
 * app capabilities. `forge doctor clients` covers ALL catalog/config clients
 * using the authoritative clientInstalled/IsClientEnabled facts.
 */

import type { ChildProcess } from 'node:child_process'

import { spawnForge } from '../../adapters/forge/exec.mts'
import { killProcessTree } from '../../adapters/shell/process.mts'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_STDOUT_BYTES = 256 * 1024
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

export type ForgeClientReadinessErrorCode =
  | 'spawn_failed'
  | 'timeout'
  | 'output_limit'
  | 'command_failed'
  | 'invalid_response'

export class ForgeClientReadinessError extends Error {
  constructor(readonly code: ForgeClientReadinessErrorCode) {
    super(`Forge client readiness query failed (${code})`)
    this.name = 'ForgeClientReadinessError'
  }
}

/** Authoritative per-client config/installation state. */
export interface ForgeClientReadiness {
  readonly enabled: boolean
  readonly installed: boolean
}

export interface ForgeClientReadinessSnapshot {
  /** Completion time of the authoritative non-inference client read. */
  readonly sampledAtMs: number
  /** Exact client id -> authoritative config/installation state. */
  readonly clientsById: Readonly<Record<string, ForgeClientReadiness>>
}

interface QueryOptions {
  env?: NodeJS.ProcessEnv
  now?: () => number
  timeoutMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
  killProcessTreeImpl?: (pid: number, pgid?: number) => Promise<void>
}

function isSafeClientId(id: string): boolean {
  return id.length > 0 && id.trim() === id && id.length <= 120 && !/[\u0000-\u001f\u007f]/.test(id)
}

/**
 * Strictly parses a `forge doctor clients --json` report, projecting only the
 * safe `clients` adapter check details. The report must be ok, contain exactly
 * one valid `clients` check whose details map every id to strict booleans, and
 * must reject malformed/conflicting/unknown shapes.
 */
export function parseForgeClientReadinessJson(text: string): Readonly<Record<string, ForgeClientReadiness>> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ForgeClientReadinessError('invalid_response')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ForgeClientReadinessError('invalid_response')
  }
  const report = value as Record<string, unknown>
  if (report.ok !== true) throw new ForgeClientReadinessError('invalid_response')

  const checks = report.checks
  if (!Array.isArray(checks)) throw new ForgeClientReadinessError('invalid_response')
  let detailsRaw: unknown
  let sawClients = false
  for (const item of checks) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const check = item as Record<string, unknown>
    if (check.adapter !== 'clients') continue
    if (sawClients) throw new ForgeClientReadinessError('invalid_response')
    if (check.status !== 'ok' && check.status !== 'warning') throw new ForgeClientReadinessError('invalid_response')
    detailsRaw = check.details
    sawClients = true
  }
  if (!sawClients || detailsRaw === undefined || detailsRaw === null
    || typeof detailsRaw !== 'object' || Array.isArray(detailsRaw)) {
    throw new ForgeClientReadinessError('invalid_response')
  }

  const projected: Record<string, ForgeClientReadiness> = Object.create(null) as Record<string, ForgeClientReadiness>
  for (const [id, raw] of Object.entries(detailsRaw as Record<string, unknown>)) {
    if (!isSafeClientId(id)) throw new ForgeClientReadinessError('invalid_response')
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ForgeClientReadinessError('invalid_response')
    }
    const entry = raw as Record<string, unknown>
    const enabled = entry.enabled
    const installed = entry.installed
    if (typeof enabled !== 'boolean' || typeof installed !== 'boolean') {
      throw new ForgeClientReadinessError('invalid_response')
    }
    projected[id] = Object.freeze({ enabled, installed })
  }
  return Object.freeze(projected)
}

/** Runs one bounded client readiness read and returns only the immutable safe projection. */
export async function queryForgeClientReadiness(
  options: QueryOptions = {},
): Promise<ForgeClientReadinessSnapshot> {
  const text = await collectClientReadiness(options)
  const clientsById = parseForgeClientReadinessJson(text)
  return Object.freeze({
    sampledAtMs: (options.now ?? (() => Date.now()))(),
    clientsById,
  })
}

function collectClientReadiness(options: QueryOptions): Promise<string> {
  const timeoutMs = positiveBound(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxStdoutBytes = positiveBound(options.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES)
  const maxStderrBytes = positiveBound(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES)
  const killTree = options.killProcessTreeImpl ?? killProcessTree

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnForge(['doctor', 'clients', '--json'], {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // A separate POSIX process group lets timeout/cap handling terminate
        // the complete Forge child tree. Windows uses taskkill /T.
        detached: process.platform !== 'win32',
      })
    } catch {
      reject(new ForgeClientReadinessError('spawn_failed'))
      return
    }

    let settled = false
    let terminating = false
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdout: Buffer[] = []

    const cleanup = (): void => {
      clearTimeout(timer)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      child.stdout?.removeListener('data', onStdout)
      child.stderr?.removeListener('data', onStderr)
    }
    const finish = (error?: ForgeClientReadinessError): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(Buffer.concat(stdout).toString('utf8'))
    }
    const terminate = (code: ForgeClientReadinessErrorCode): void => {
      if (settled || terminating) return
      terminating = true
      clearTimeout(timer)
      const pid = child.pid
      if (pid === undefined) {
        finish(new ForgeClientReadinessError(code))
        return
      }
      void killTree(pid, process.platform === 'win32' ? undefined : pid)
        .catch(() => undefined)
        .then(() => finish(new ForgeClientReadinessError(code)))
    }
    const onStdout = (chunk: Buffer | string): void => {
      if (terminating) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stdoutBytes += buffer.byteLength
      if (stdoutBytes > maxStdoutBytes) {
        terminate('output_limit')
        return
      }
      stdout.push(buffer)
    }
    const onStderr = (chunk: Buffer | string): void => {
      if (terminating) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stderrBytes += buffer.byteLength
      if (stderrBytes > maxStderrBytes) terminate('output_limit')
      // Stderr is intentionally counted but never retained or exposed.
    }
    const onError = (): void => {
      if (!terminating) finish(new ForgeClientReadinessError('spawn_failed'))
    }
    const onClose = (code: number | null): void => {
      if (terminating) return
      if (code !== 0) {
        finish(new ForgeClientReadinessError('command_failed'))
        return
      }
      finish()
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    const timer = setTimeout(() => terminate('timeout'), timeoutMs)
    timer.unref()
  })
}

function positiveBound(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}
