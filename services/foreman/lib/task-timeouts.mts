export const STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS = 15 * 60 * 1000
export const STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS = 60 * 1000
export const TASK_TIMEOUT_SCOPE = 'agent_attempt' as const

export type TaskTimeoutScope = typeof TASK_TIMEOUT_SCOPE

export function effectiveTaskTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs ?? STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS
}

export function assertValidTimeoutMs(timeoutMs: unknown, fieldName = 'timeoutMs'): asserts timeoutMs is number | undefined {
  if (timeoutMs === undefined || timeoutMs === null) return
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer in milliseconds`)
  }
}
