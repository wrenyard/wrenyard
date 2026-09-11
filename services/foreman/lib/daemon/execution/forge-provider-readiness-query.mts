import { canonicalizeBuiltinPublicModelId } from '@wrenyard/providers'
/**
 * Bounded, non-inference access to Forge's authoritative provider auth status.
 *
 * The child runs exactly `forge providers list --json`. Only the public
 * `{id, auth_ok}` projection plus a strictly validated optional Cursor
 * `model_availability` map are retained; benign additional fields are ignored
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

export type ForgeModelAvailabilityStatus = 'available' | 'blocked' | 'unknown'
export type ForgeModelAvailabilityReason =
  | 'admin_blocked'
  | 'consent_required'
  | 'model_disabled'
  | 'unsupported'

export interface ForgeModelAvailability {
  readonly status: ForgeModelAvailabilityStatus
  readonly reason?: ForgeModelAvailabilityReason
}

export interface ForgeProviderReadinessSnapshot {
  /** Completion time of the authoritative non-inference status read. */
  readonly sampledAtMs: number
  /** Exact canonical provider id -> current Forge auth status. */
  readonly authByProvider: Readonly<Record<string, boolean>>
  /** Safe Cursor per-model access; absent/malformed data never means available. */
  readonly cursorModelAvailability?: Readonly<Record<string, ForgeModelAvailability>>
}

export interface ForgeNativeRoute {
  /** Canonical provider id returned by Forge provider status. */
  readonly providerId: string
  readonly client: string
  readonly mode: 'native' | 'gateway'
  readonly nativeClients: readonly string[]
  /** Exact runtime model id; required for Cursor native admission. */
  readonly model?: string
}

export type ForgeNativeRouteReadiness = 'available' | 'missing' | 'unknown' | 'unsupported' | 'blocked'

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

const SAFE_MODEL_STATUS = new Set<ForgeModelAvailabilityStatus>(['available', 'blocked', 'unknown'])
const SAFE_MODEL_REASON = new Set<ForgeModelAvailabilityReason>([
  'admin_blocked',
  'consent_required',
  'model_disabled',
  'unsupported',
])

function isSafeModelId(id: string): boolean {
  return id.length > 0 && id.trim() === id && id.length <= 120 && !/[\u0000-\u001f\u007f]/.test(id)
}

function parseOneModelAvailability(value: unknown): ForgeModelAvailability | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const status = row.status
  if (typeof status !== 'string' || !SAFE_MODEL_STATUS.has(status as ForgeModelAvailabilityStatus)) return undefined
  const projected: ForgeModelAvailability = { status: status as ForgeModelAvailabilityStatus }
  if (typeof row.reason === 'string' && SAFE_MODEL_REASON.has(row.reason as ForgeModelAvailabilityReason)) {
    return { ...projected, reason: row.reason as ForgeModelAvailabilityReason }
  }
  return projected
}

function projectCursorModelAvailabilityMap(raw: unknown): Readonly<Record<string, ForgeModelAvailability>> | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.freeze(Object.create(null) as Record<string, ForgeModelAvailability>)
  }
  const projected: Record<string, ForgeModelAvailability> = Object.create(null) as Record<string, ForgeModelAvailability>
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeModelId(id)) continue
    const parsed = parseOneModelAvailability(value)
    if (parsed === undefined) continue
    const canonicalId = canonicalizeBuiltinPublicModelId(`cursor/${id}`).slice('cursor/'.length)
    const previous = projected[canonicalId]
    projected[canonicalId] = previous !== undefined
      && (previous.status !== parsed.status || previous.reason !== parsed.reason)
      ? { status: 'unknown' } : parsed
  }
  return Object.freeze(projected)
}

/** Projects Cursor model_availability from a providers-list payload already auth-validated. */
export function parseForgeCursorModelAvailability(text: string): Readonly<Record<string, ForgeModelAvailability>> | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ForgeProviderReadinessError('invalid_response')
  }
  if (!Array.isArray(value)) throw new ForgeProviderReadinessError('invalid_response')
  let found: Readonly<Record<string, ForgeModelAvailability>> | undefined
  let sawCursor = false
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    if (row.id !== 'cursor') continue
    const incoming = projectCursorModelAvailabilityMap(row.model_availability)
    if (!sawCursor) {
      found = incoming
    } else {
      const merged: Record<string, ForgeModelAvailability> = Object.create(null)
      for (const id of new Set([...Object.keys(found ?? {}), ...Object.keys(incoming ?? {})])) {
        const a = found?.[id]
        const b = incoming?.[id]
        merged[id] = a !== undefined && b !== undefined && a.status === b.status && a.reason === b.reason
          ? a : { status: 'unknown' }
      }
      found = Object.freeze(merged)
    }
    sawCursor = true
  }
  if (!sawCursor) return undefined
  return found
}

/** Native auth is valid only for the exact native route and exact provider. */
export function evaluateForgeNativeRouteReadiness(
  snapshot: ForgeProviderReadinessSnapshot | undefined,
  route: ForgeNativeRoute,
): ForgeNativeRouteReadiness {
  if (
    route.mode !== 'native'
    || (route.providerId !== 'chatgpt' && route.providerId !== 'cursor')
    || !route.nativeClients.includes(route.client)
  ) return 'unsupported'
  if (snapshot === undefined) return 'unknown'
  const authOk = snapshot.authByProvider[route.providerId]
  if (route.providerId === 'chatgpt') {
    return authOk === true ? 'available' : authOk === false ? 'missing' : 'unknown'
  }
  if (authOk === false) return 'missing'
  if (authOk !== true) return 'unknown'
  const model = route.model
  if (typeof model !== 'string' || !isSafeModelId(model)) return 'unknown'
  const availability = snapshot.cursorModelAvailability?.[model]
  if (availability === undefined) return 'unknown'
  if (availability.status === 'available') return 'available'
  if (availability.status === 'blocked') return 'blocked'
  return 'unknown'
}

/** Runs one bounded status read and returns only the immutable safe projection. */
export async function queryForgeProviderReadiness(
  options: QueryOptions = {},
): Promise<ForgeProviderReadinessSnapshot> {
  const text = await collectProviderStatus(options)
  const authByProvider = parseForgeProviderReadinessJson(text)
  const cursorModelAvailability = parseForgeCursorModelAvailability(text)
  return Object.freeze({
    sampledAtMs: (options.now ?? (() => Date.now()))(),
    authByProvider,
    ...(cursorModelAvailability === undefined ? {} : { cursorModelAvailability }),
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
