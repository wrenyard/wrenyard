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

// ── Agent-runtime failure classification ────────────────────────────────
//
// Canonical failure classification surfaced by the native clients on
// `run_finished` records. The union matches the closed classifier values the
// native agent runtime may emit; `none` means the run succeeded / no failure
// class applies. Only these five values are legal — task-domain code must
// never synthesize a different value, and must not collapse a classified
// runtime failure into the generic `agent_failed` bucket.

export type AgentFailureClass =
  | 'none'
  | 'profile_specific_limit'
  | 'transient_provider'
  | 'non_retryable'
  | 'policy_exhausted'

/**
 * Plain label for a client-reported model rejection. Route health and user-visible
 * error types are derived from gateway classification of the upstream error, not
 * from diagnostic text patterns.
 */
export const MODEL_REJECTION_FAILURE_CLASS = 'model_rejected'

/**
 * Plain label for a client-reported quota or rate limit. Route health and
 * user-visible error types are derived from gateway classification of the
 * upstream error, not from diagnostic text patterns.
 */
export const QUOTA_OR_RATE_LIMITED_FAILURE_CLASS = 'quota_or_rate_limited'

/** Gateway error-code vocabulary names surfaced in task failure text. */
export type GatewayFailureClass =
  | 'auth_failed'
  | 'access_denied'
  | 'model_unavailable'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'transport'
  | 'structured_output'
  | 'runtime_error'

const GATEWAY_FAILURE_CLASS_SET = new Set<string>([
  'auth_failed',
  'access_denied',
  'model_unavailable',
  'quota_exhausted',
  'rate_limited',
  'timeout',
  'server_error',
  'transport',
  'structured_output',
  'runtime_error',
])

export interface AgentFailedErrorUpstream {
  status?: number
  errorType?: string
  message?: string
  /** An explicitly stated reset instant, as an ISO timestamp. */
  resetsAt?: string
}

function firstLineOf(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined || text.length === 0) return undefined
  const line = text.split(/\r?\n/, 1)[0]?.trim()
  return line === '' ? undefined : line
}

/** Generic HTTP status to gateway fault kind (matches gateway genericFailure). */
export function genericFailureClassFromStatus(status: number): GatewayFailureClass | undefined {
  if (status === 429) return 'rate_limited'
  if (status === 402) return 'quota_exhausted'
  if (status === 401) return 'auth_failed'
  if (status === 403) return 'access_denied'
  if (status === 404) return 'model_unavailable'
  if (status === 408) return 'timeout'
  if (status >= 500) return 'server_error'
  return undefined
}

/**
 * Map a failure class or upstream error to the error-codes table name used in
 * user-visible task failure text.
 */
export function taskVisibleFailureClassToken(
  failureClass: AgentFailureClass | string | null | undefined,
  upstream?: AgentFailedErrorUpstream | null,
): GatewayFailureClass | undefined {
  // A 429 that states its reset is an allowance exhausted until then, the
  // same reading the provider classifier gives the route.
  if (upstream?.status === 429 && upstream.resetsAt !== undefined) return 'quota_exhausted'
  if (upstream?.status !== undefined) {
    const fromStatus = genericFailureClassFromStatus(upstream.status)
    if (fromStatus !== undefined) return fromStatus
  }
  if (failureClass === null || failureClass === undefined || failureClass === 'none') return undefined
  if (GATEWAY_FAILURE_CLASS_SET.has(failureClass)) return failureClass as GatewayFailureClass
  switch (failureClass) {
    case MODEL_REJECTION_FAILURE_CLASS:
      return 'model_unavailable'
    case QUOTA_OR_RATE_LIMITED_FAILURE_CLASS:
      return 'rate_limited'
    case 'profile_specific_limit':
    case 'policy_exhausted':
      return 'quota_exhausted'
    case 'transient_provider':
      return 'server_error'
    case 'non_retryable':
      return 'runtime_error'
    default:
      return undefined
  }
}

/** First line of upstream reason for task failure text and error_message JSON. */
export function upstreamFailureReasonFirstLine(
  upstream?: AgentFailedErrorUpstream | null,
  detail?: string | null,
): string | undefined {
  if (upstream !== null && upstream !== undefined
    && (upstream.status !== undefined || upstream.errorType !== undefined || upstream.message !== undefined)) {
    const parts: string[] = []
    if (upstream.status !== undefined) parts.push(`HTTP ${upstream.status}`)
    if (upstream.errorType !== undefined) {
      parts.push(upstream.message !== undefined && upstream.message !== ''
        ? `${upstream.errorType}: ${upstream.message}`
        : upstream.errorType)
    } else if (upstream.message !== undefined && upstream.message !== '') {
      parts.push(upstream.message)
    }
    return firstLineOf(parts.join(' '))
  }
  return firstLineOf(detail)
}

/**
 * Distinct task failure categories that must stay separable in reporting. The
 * structured-output collector and supervisor map classified agent-runtime
 * failures onto these without inferring from error text; the categories below
 * are deliberately kept apart from `agent_failed` so a capacity/policy
 * exhaustion is observable as a runtime/transport problem rather than a
 * generic agent failure.
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
 * Map a canonical agent-runtime FailureClass to a stable task failure category.
 *
 * - `profile_specific_limit` / `policy_exhausted` -> `runtime_status`
 * - `transient_provider` -> `transport`
 * - `non_retryable` -> `agent_failed`
 * - `model_rejected` (client-reported model rejection) -> `runtime_status`
 * - `none` / undefined -> undefined (not a failure; callers default unknown
 *   failed agents to `agent_failed`)
 *
 * Returns undefined for unknown values so callers can decide; the structured
 * collector treats a missing/unknown class as `agent_failed`.
 */
export function mapAgentFailureClass(
  failureClass: AgentFailureClass | string | null | undefined,
): TaskFailureCategory | undefined {
  switch (failureClass) {
    case 'profile_specific_limit':
    case 'policy_exhausted':
      return 'runtime_status'
    case 'transient_provider':
      return 'transport'
    case 'non_retryable':
      return 'agent_failed'
    // A client-reported model rejection is a runtime/status problem of the exact
    // route (the resolved model cannot serve this account), so it stays
    // observable as runtime_status rather than a generic agent failure. Existing
    // class mappings above are unchanged.
    case MODEL_REJECTION_FAILURE_CLASS:
      return 'runtime_status'
    // A quota-exhausted / rate-limited native route is a recoverable capacity
    // problem: the route's free pool is marked exhausted and an automatically
    // routed task re-resolves to the next route. Same runtime_status category as
    // a model rejection.
    case QUOTA_OR_RATE_LIMITED_FAILURE_CLASS:
      return 'runtime_status'
    case 'auth_failed':
    case 'access_denied':
    case 'model_unavailable':
    case 'quota_exhausted':
    case 'rate_limited':
    case 'timeout':
    case 'server_error':
    case 'transport':
    case 'structured_output':
    case 'runtime_error':
      return failureClass === 'timeout' || failureClass === 'server_error' || failureClass === 'transport'
        ? 'transport'
        : 'runtime_status'
    case 'none':
    case undefined:
    case null:
      return undefined
    default:
      // Unknown classifier value: leave unmapped so callers default safely.
      return undefined
  }
}

/** Stable structured payload builder for a classified agent-runtime failure. */
export function agentFailurePayload(
  failureClass: AgentFailureClass | string | null | undefined,
  executionId: string,
  detail?: string | null,
): { type: TaskFailureCategory; execution_id: string; status: 'failed'; detail?: string } {
  const category = mapAgentFailureClass(failureClass) ?? 'agent_failed'
  return {
    type: category,
    execution_id: executionId,
    status: 'failed',
    ...(detail ? { detail: detail.slice(0, 2000) } : {}),
  }
}

export function agentFailedError(
  executionId: string,
  detail?: string | null,
  failureClass?: AgentFailureClass | string | null,
  upstreamError?: AgentFailedErrorUpstream | null,
): Error & { failure_category: string; error_message: string } {
  const category = mapAgentFailureClass(failureClass) ?? 'agent_failed'
  const classToken = taskVisibleFailureClassToken(failureClass, upstreamError)
  const reason = upstreamFailureReasonFirstLine(upstreamError, detail)
  // The cause always reaches the caller: the classified type with the
  // upstream's own message, else the execution's own error line, else its id.
  const message = reason === undefined
    ? `Agent execution failed: ${executionId}`
    : classToken === undefined
      ? `Agent execution failed: ${reason}`
      : `Agent execution failed (${classToken}): ${reason}`

  return Object.assign(
    new Error(message),
    {
      failure_category: category,
      error_message: JSON.stringify({
        type: category,
        execution_id: executionId,
        status: 'failed',
        ...(failureClass ? { agent_failure_class: failureClass } : {}),
        ...(classToken !== undefined ? { class: classToken } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(detail ? { detail: detail.slice(0, 2000) } : {}),
      }),
    },
  )
}
