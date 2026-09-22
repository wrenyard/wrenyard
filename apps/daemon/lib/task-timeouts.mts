/** Total wall-clock model-execution budget in ms for a task: one shared
 *  deadline across the initial native-agent attempt and every structured-output
 *  resume attempt, beginning when model execution starts. Never renewed per
 *  attempt. */
export const STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS = 15 * 60 * 1000
/** Per-attempt structured-output resume timeout in ms. A retry is capped at
 *  this value and additionally bounded by the positive remaining total
 *  model-execution budget, so it can never outlive the shared deadline. */
export const STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS = 60 * 1000
/** Labels timeoutMs metadata as the shared task-execution deadline rather than
 *  a per-agent-attempt budget. */
export const TASK_TIMEOUT_SCOPE = 'task_execution' as const

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
