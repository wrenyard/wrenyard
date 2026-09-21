import { type ScoreWeights } from './types.ts';
import { SCORE_WEIGHTS_KEYS, SCORE_WEIGHTS_SUM_TOLERANCE } from './constants.ts';
/**
 * Strictly validates arbitrary input as a complete four-key weight set: every
 * key P/S/Q/I must be present, finite, and within [0, 1], and the values must
 * sum to 1 (within a small floating-point tolerance). Throws with a clear
 * message on any violation; invalid weights are never silently replaced by
 * the defaults.
 */
export function validateScoreWeights(weights: unknown): ScoreWeights {
  if (typeof weights !== "object" ||
    weights === null ||
    Array.isArray(weights)) {
    throw new Error("invalid score weights: expected an object with keys P, S, Q, I");
  }
  const record = weights as Record<string, unknown>;
  const normalized: Record<string, number> = {};
  for (const key of SCORE_WEIGHTS_KEYS) {
    if (!(key in record)) {
      throw new Error(`invalid score weights: missing required key ${key}`);
    }
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`invalid score weights: ${key} must be a finite number`);
    }
    if (value < 0 || value > 1) {
      throw new Error(`invalid score weights: ${key} must be within [0, 1]`);
    }
    normalized[key] = value;
  }
  for (const key of Object.keys(record)) {
    if (!(SCORE_WEIGHTS_KEYS as readonly string[]).includes(key)) {
      throw new Error(`invalid score weights: unknown key ${key}`);
    }
  }
  const sum = normalized.P + normalized.S + normalized.Q + normalized.I;
  if (Math.abs(sum - 1) > SCORE_WEIGHTS_SUM_TOLERANCE) {
    throw new Error(`invalid score weights: values must sum to 1 (got ${sum})`);
  }
  return { P: normalized.P, S: normalized.S, Q: normalized.Q, I: normalized.I };
}
/** Defensive immutable copy of a validated weight set. */
export function snapshotScoreWeights(weights: ScoreWeights): ScoreWeights {
  return Object.freeze({ ...validateScoreWeights(weights) });
}
