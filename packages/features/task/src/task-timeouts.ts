/** Per-attempt structured-output resume timeout in ms. A retry is capped at
 *  this value and additionally bounded by the positive remaining total
 *  model-execution budget, so it can never outlive the shared deadline. */
export const STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS = 60 * 1000

export function assertValidTimeoutMs(timeoutMs: unknown, fieldName = 'timeoutMs'): asserts timeoutMs is number | undefined {
  if (timeoutMs === undefined || timeoutMs === null) return
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer in milliseconds`)
  }
}
