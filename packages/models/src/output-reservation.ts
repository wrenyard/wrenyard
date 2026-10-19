/**
 * Upper bound on the output tokens one request reserves against its context
 * window. A model declaring a larger maximum still leaves the rest of the
 * window to input, so a huge declared maximum can never starve the budget.
 */
export const CONTEXT_OUTPUT_RESERVATION_CAP = 32_768;

/**
 * Output tokens one request reserves against its context window: the model's
 * declared maximum, bounded by {@link CONTEXT_OUTPUT_RESERVATION_CAP}. The same
 * value is what the context budget, the compaction threshold and the request's
 * own `max_tokens` use. Undefined when the model declares no maximum, so a
 * caller keeps skipping the reservation instead of inventing one.
 */
export function boundedOutputReservation(maxOutputTokens: number | undefined): number | undefined {
  if (maxOutputTokens === undefined) return undefined;
  return Math.min(maxOutputTokens, CONTEXT_OUTPUT_RESERVATION_CAP);
}
