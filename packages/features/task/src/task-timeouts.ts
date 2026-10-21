export function assertValidTimeoutMs(timeoutMs: unknown, fieldName = 'timeoutMs'): asserts timeoutMs is number | undefined {
  if (timeoutMs === undefined || timeoutMs === null) return
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer in milliseconds`)
  }
}
