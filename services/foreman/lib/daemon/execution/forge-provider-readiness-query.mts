/**
 * Bounded, non-inference access to Forge's authoritative provider auth status.
 *
 * The child runs exactly `forge providers list --json`. Only the public
 * `{id, auth_ok}` projection is retained; benign additional fields are ignored
 * and no credential, token, path, stderr, or raw response is returned through
 * this module. Native-route admission remains a separate caller decision.
 */

import type { ChildProcess } from 'node:child_process'

import { spawnForge } from '../../adapters/forge/exec.mts'
import { killProcessTree } from '../../adapters/shell/process.mts'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_STDOUT_BYTES = 256 * 1024
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

export type ForgeProviderReadinessErrorCode =
  | 'spawn_failed'
  | 'timeout'
  | 'output_limit'
  | 'command_failed'
  | 'invalid_response'

export class ForgeProviderReadinessError extends Error {
  constructor(readonly code: ForgeProviderReadinessErrorCode) {
    super(`Forge provider readiness query failed (${code})`)
    this.name = 'ForgeProviderReadinessError'
  }
}

export interface ForgeProviderReadinessSnapshot {
  /** Completion time of the authoritative non-inference status read. */
  readonly sampledAtMs: number
  /** Exact canonical provider id -> current Forge auth status. */
  readonly authByProvider: Readonly<Record<string, boolean>>
}

export interface ForgeNativeRoute {
  /** Canonical Forge provider-status identity (the Catalog credentialResolver),
   * not necessarily the Catalog provider id. For example, codex-spark shares
   * the `codex` native credential resolver and readiness row. */
  readonly credentialResolverId: string
  readonly client: string
  readonly mode: 'native' | 'gateway'
  readonly nativeClients: readonly string[]
}

export type ForgeNativeRouteReadiness = 'available' | 'missing' | 'unknown' | 'unsupported'

interface QueryOptions {
  env?: NodeJS.ProcessEnv
  now?: () => number
  timeoutMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
  killProcessTreeImpl?: (pid: number, pgid?: number) => Promise<void>
}

/**
 * Strictly validates required status fields while projecting away legitimate
 * additional provider-list fields. Identical duplicate rows are harmless;
 * conflicting duplicates and non-boolean auth state reject the whole sample.
 */
export function parseForgeProviderReadinessJson(text: string): Readonly<Record<string, boolean>> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ForgeProviderReadinessError('invalid_response')
  }
  if (!Array.isArray(value)) throw new ForgeProviderReadinessError('invalid_response')

  const projected: Record<string, boolean> = Object.create(null) as Record<string, boolean>
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ForgeProviderReadinessError('invalid_response')
    }
    const row = item as Record<string, unknown>
    const id = row.id
    const authOk = row.auth_ok
    if (typeof id !== 'string' || id.length === 0 || id.trim() !== id || id.length > 120) {
      throw new ForgeProviderReadinessError('invalid_response')
    }
    if (typeof authOk !== 'boolean') throw new ForgeProviderReadinessError('invalid_response')
    if (Object.hasOwn(projected, id) && projected[id] !== authOk) {
      throw new ForgeProviderReadinessError('invalid_response')
    }
    projected[id] = authOk
  }
  return Object.freeze(projected)
}

/** Native auth is valid only for the exact native route and exact provider. */
export function evaluateForgeNativeRouteReadiness(
  snapshot: ForgeProviderReadinessSnapshot | undefined,
  route: ForgeNativeRoute,
): ForgeNativeRouteReadiness {
  if (
    route.mode !== 'native'
    || (route.credentialResolverId !== 'codex' && route.credentialResolverId !== 'cursor')
    || !route.nativeClients.includes(route.client)
  ) return 'unsupported'
  if (snapshot === undefined) return 'unknown'
  const authOk = snapshot.authByProvider[route.credentialResolverId]
  return authOk === true ? 'available' : authOk === false ? 'missing' : 'unknown'
}

/** Runs one bounded status read and returns only the immutable safe projection. */
export async function queryForgeProviderReadiness(
  options: QueryOptions = {},
): Promise<ForgeProviderReadinessSnapshot> {
  const text = await collectProviderStatus(options)
  const authByProvider = parseForgeProviderReadinessJson(text)
  return Object.freeze({
    sampledAtMs: (options.now ?? (() => Date.now()))(),
    authByProvider,
  })
}

function collectProviderStatus(options: QueryOptions): Promise<string> {
  const timeoutMs = positiveBound(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxStdoutBytes = positiveBound(options.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES)
  const maxStderrBytes = positiveBound(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES)
  const killTree = options.killProcessTreeImpl ?? killProcessTree

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnForge(['providers', 'list', '--json'], {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // A separate POSIX process group lets timeout/cap handling terminate
        // the complete Forge child tree. Windows uses taskkill /T.
        detached: process.platform !== 'win32',
      })
    } catch {
      reject(new ForgeProviderReadinessError('spawn_failed'))
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
    const finish = (error?: ForgeProviderReadinessError): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(Buffer.concat(stdout).toString('utf8'))
    }
    const terminate = (code: ForgeProviderReadinessErrorCode): void => {
      if (settled || terminating) return
      terminating = true
      clearTimeout(timer)
      const pid = child.pid
      if (pid === undefined) {
        finish(new ForgeProviderReadinessError(code))
        return
      }
      void killTree(pid, process.platform === 'win32' ? undefined : pid)
        .catch(() => undefined)
        .then(() => finish(new ForgeProviderReadinessError(code)))
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
      if (!terminating) finish(new ForgeProviderReadinessError('spawn_failed'))
    }
    const onClose = (code: number | null): void => {
      if (terminating) return
      if (code !== 0) {
        finish(new ForgeProviderReadinessError('command_failed'))
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
