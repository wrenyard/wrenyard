export interface GateFailurePayload {
  type: 'gate_failed'
  phase: 'pre' | 'post'
  gate_id: string
  expected: string
  actual: string
  evidence?: unknown
  remediation?: string
  retryable?: boolean
}

export class GateFailureError extends Error {
  public readonly failure_category = 'gate_failed' as const
  public readonly failure: GateFailurePayload
  public readonly suggestion: string
  public readonly error_message: string

  constructor(
    phase: 'pre' | 'post',
    gateId: string,
    expected: string,
    actual: string,
    opts?: { evidence?: unknown; remediation?: string; retryable?: boolean },
  ) {
    super(`Gate '${gateId}' failed (${phase}): expected ${expected}, got ${actual}`)
    this.name = 'GateFailureError'
    this.failure = {
      type: 'gate_failed',
      phase,
      gate_id: gateId,
      expected,
      actual,
    }
    if (opts?.evidence !== undefined) this.failure.evidence = opts.evidence
    if (opts?.remediation !== undefined) this.failure.remediation = opts.remediation
    if (opts?.retryable !== undefined) this.failure.retryable = opts.retryable
    this.suggestion = opts?.remediation ?? `Gate '${gateId}' failed at ${phase}. Check the failure report.`
    this.error_message = JSON.stringify(this.failure)
  }
}

export function isGateError(error: unknown): error is GateFailureError {
  return error instanceof Error && error.name === 'GateFailureError' && (error as GateFailureError).failure_category === 'gate_failed'
}

export function extractGateFailure(error: unknown): GateFailurePayload | undefined {
  if (isGateError(error)) return error.failure
  return undefined
}

// ── Forge FailureClass mapping ──────────────────────────────────────────
//
// Canonical Forge failure classification surfaced on `forge.agent.stream` v1
// `run_finished` events. The union matches the closed classifier values the Go
// runtime emits; `none` means the run succeeded / no failure class applies.
// Only these five values are legal — task-domain code must never synthesize a
// different value, and must not collapse a classified runtime failure into the
// generic `agent_failed` bucket.

export type ForgeFailureClass =
  | 'none'
  | 'profile_specific_limit'
  | 'transient_provider'
  | 'non_retryable'
  | 'policy_exhausted'

/**
 * Distinct task failure categories that must stay separable in reporting. The
 * structured-output collector and supervisor map Forge failures onto these
 * without inferring from error text; the categories below are deliberately
 * kept apart from `agent_failed` so a capacity/policy exhaustion is observable
 * as a runtime/transport problem rather than a generic agent failure.
 */
export type TaskFailureCategory =
  | 'input_validation_failed'
  | 'gate_failed'
  | 'agent_failed'
  | 'agent_timeout'
  | 'task_cancelled'
  | 'task_interrupted'
  | 'agent_cancelled'
  | 'agent_interrupted'
  | 'runtime_status'
  | 'transport'

/**
 * Map a canonical Forge FailureClass to a stable task failure category.
 *
 * - `profile_specific_limit` / `policy_exhausted` -> `runtime_status`
 * - `transient_provider` -> `transport`
 * - `non_retryable` -> `agent_failed`
 * - `none` / undefined -> undefined (not a failure; callers default unknown
 *   failed agents to `agent_failed`)
 *
 * Returns undefined for unknown values so callers can decide; the structured
 * collector treats a missing/unknown class as `agent_failed`.
 */
export function mapForgeFailureClass(
  failureClass: ForgeFailureClass | string | null | undefined,
): TaskFailureCategory | undefined {
  switch (failureClass) {
    case 'profile_specific_limit':
    case 'policy_exhausted':
      return 'runtime_status'
    case 'transient_provider':
      return 'transport'
    case 'non_retryable':
      return 'agent_failed'
    case 'none':
    case undefined:
    case null:
      return undefined
    default:
      // Unknown classifier value: leave unmapped so callers default safely.
      return undefined
  }
}

/** Stable structured payload builder for a Forge-classified failure. */
export function forgeFailurePayload(
  failureClass: ForgeFailureClass | string | null | undefined,
  executionId: string,
  detail?: string | null,
): { type: TaskFailureCategory; execution_id: string; status: 'failed'; detail?: string } {
  const category = mapForgeFailureClass(failureClass) ?? 'agent_failed'
  return {
    type: category,
    execution_id: executionId,
    status: 'failed',
    ...(detail ? { detail: detail.slice(0, 2000) } : {}),
  }
}
