import { canonicalizeBuiltinPublicModelId } from '@wrenyard/providers'
import type { NativeModelAvailability, NativeModelAvailabilityReason, NativeModelAvailabilityStatus } from '@wrenyard/clients'
export type { NativeModelAvailability, NativeModelAvailabilityReason, NativeModelAvailabilityStatus } from '@wrenyard/clients'

/**
 * Neutral native-provider readiness shape and pure route evaluation.
 *
 * A readiness snapshot is assembled at the daemon boundary from genuine client
 * observations (each AgentClient's optional `readReadiness`) plus explicit
 * known provider bindings. This module owns only the safe projection and the
 * pure decision rules; it performs no I/O, no Wrenyard subprocess, and no
 * credential handling. Automatic-routing admission is deliberately unchanged:
 * these are the same rules the retired Wrenyard providers-list query enforced.
 */

export interface NativeProviderReadinessSnapshot {
  /** Completion time of the authoritative non-inference status read. */
  readonly sampledAtMs: number
  /** Canonical provider id -> current native auth status. */
  readonly authByProvider: Readonly<Record<string, boolean>>
  /** Safe Cursor per-model access; absent/malformed data never means available. */
  readonly cursorModelAvailability?: Readonly<Record<string, NativeModelAvailability>>
}

export interface NativeRoute {
  /** Canonical provider id. */
  readonly providerId: string
  readonly client: string
  readonly mode: 'native' | 'gateway'
  readonly nativeClients: readonly string[]
  /** Exact runtime model id; required for Cursor native admission. */
  readonly model?: string
}

export type NativeRouteReadiness = 'available' | 'missing' | 'unknown' | 'unsupported' | 'blocked'

const SAFE_MODEL_STATUS = new Set<NativeModelAvailabilityStatus>(['available', 'blocked', 'unknown'])
const SAFE_MODEL_REASON = new Set<NativeModelAvailabilityReason>([
  'admin_blocked',
  'consent_required',
  'model_disabled',
  'unsupported',
])

function isSafeModelId(id: string): boolean {
  return id.length > 0 && id.trim() === id && id.length <= 120 && !/[\u0000-\u001f\u007f]/.test(id)
}

function parseOneModelAvailability(value: unknown): NativeModelAvailability | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const status = row.status
  if (typeof status !== 'string' || !SAFE_MODEL_STATUS.has(status as NativeModelAvailabilityStatus)) return undefined
  const projected: NativeModelAvailability = { status: status as NativeModelAvailabilityStatus }
  if (typeof row.reason === 'string' && SAFE_MODEL_REASON.has(row.reason as NativeModelAvailabilityReason)) {
    return { ...projected, reason: row.reason as NativeModelAvailabilityReason }
  }
  return projected
}

/**
 * Projects one client's safe per-model status map to canonical public model
 * ids. Unsafe ids and malformed rows are dropped; identical duplicate rows
 * collapse and conflicting duplicates become unknown. Every key is canonical.
 */
export function projectModelAvailability(
  raw: Readonly<Record<string, unknown>> | undefined,
  clientId: string,
): Readonly<Record<string, NativeModelAvailability>> | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.freeze(Object.create(null) as Record<string, NativeModelAvailability>)
  }
  const prefix = `${clientId}/`
  const projected: Record<string, NativeModelAvailability> = Object.create(null) as Record<string, NativeModelAvailability>
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeModelId(id)) continue
    const parsed = parseOneModelAvailability(value)
    if (parsed === undefined) continue
    const canonicalId = canonicalizeBuiltinPublicModelId(`${prefix}${id}`).slice(prefix.length)
    const previous = projected[canonicalId]
    projected[canonicalId] = previous !== undefined
      && (previous.status !== parsed.status || previous.reason !== parsed.reason)
      ? { status: 'unknown' } : parsed
  }
  return Object.freeze(projected)
}

/** Native auth is valid only for the exact native route and exact provider. */
export function evaluateNativeRouteReadiness(
  snapshot: NativeProviderReadinessSnapshot | undefined,
  route: NativeRoute,
): NativeRouteReadiness {
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
