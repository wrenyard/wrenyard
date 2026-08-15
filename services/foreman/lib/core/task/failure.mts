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
