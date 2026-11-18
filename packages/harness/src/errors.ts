/**
 * Harness error helpers.
 *
 * A single home for small error-shaping helpers so thrown values render to the
 * same message across harness modules. This module has no dependencies of its own.
 */

/** Human-readable message of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
