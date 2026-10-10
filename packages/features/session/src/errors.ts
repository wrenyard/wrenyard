/**
 * session error helpers.
 *
 * A single home for the small error-shaping helpers every session module used
 * to declare for itself, so a thrown value renders to the same message
 * everywhere. This module has no dependencies of its own.
 */

/** Human-readable message of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
