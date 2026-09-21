import { type ScoreWeights } from './types.ts';
export const SCORE_WEIGHTS_KEYS: readonly (keyof ScoreWeights)[] = ["P", "S", "Q", "I"];
/** Tolerance for floating-point drift when checking that weights sum to 1. */
export const SCORE_WEIGHTS_SUM_TOLERANCE = 1e-9;
/**
 * Final normalized score weights. The unified ranking score is a convex blend
 * of four bounded [0, 1] factors:
 *   P = price factor (cheaper per-M output price scores higher),
 *   S = speed factor (effective TPS, saturated at SPEED_SATURATION_BASE_TPS plus
 *       the task's expected TPS),
 *   Q = quota headroom quality,
 *   I = intelligence factor.
 *   score = .40*P + .30*S + .20*Q + .10*I, always within [0, 1].
 */
export const SCORE_WEIGHTS = { P: 0.4, S: 0.3, Q: 0.2, I: 0.1 } as const satisfies ScoreWeights;
/**
 * Fixed continuous price anchors mapping a per-M output token price (USD) to a
 * normalized price factor P in [0, 1] (see interpolatePriceFactor). Lower price
 * yields higher P; prices are interpolated linearly between anchors and any
 * price >= 50 yields P = 0. This is the single source of truth for the price
 * factor and is not a configurable DSL or runtime knob.
 */
export const PRICE_FACTOR_ANCHORS: ReadonlyArray<readonly [
  number,
  number
]> = [
  [0, 1],
  [0.5, 0.85],
  [1, 0.75],
  [2, 0.6],
  [6, 0.35],
  [30, 0.05],
  [50, 0],
];
/**
 * Global default speed saturation base (TPS). The speed factor saturates at
 * this base plus the task's declared expected TPS, so a task that expects a
 * fast model keeps rewarding faster candidates instead of treating every
 * candidate above one fixed ceiling as equally fast. A task that declares no
 * expectation saturates at the bare base.
 */
export const SPEED_SATURATION_BASE_TPS = 100;
/**
 * Zero headroom contributed by every unknown/missing/rejected constraint and
 * by every positive pay-as-you-go balance. Such evidence is an absence of
 * trusted headroom, never a neutral (or positive) quota quality.
 */
export const ZERO_QUOTA_HEADROOM = 0;
/**
 * Quota headroom credited to an aggregate that carries no trusted headroom
 * while a provider-verified unknown-quota floor applies. The value is owned by
 * the policy, never supplied by the caller, so evidence can only switch the
 * floor on - it can never inject an arbitrary quota boost. It feeds the quota
 * factor Q only: H, the tier, coverage and every eligibility gate are
 * untouched, exactly like verified quota-burn efficiency.
 */
export const UNKNOWN_QUOTA_FLOOR_HEADROOM = 0.5;
/** Full-cycle replenishment assessment constants. */
export const FULL_CYCLE_MIN_REMAINING = 0.05;
export const FULL_CYCLE_RESET_PACE = 0.8;
export const FULL_CYCLE_HEADROOM_WEIGHT = 0.75;
export const FULL_CYCLE_RESET_WEIGHT = 0.25;
/** Rolling-partial replenishment bands. */
export const HEALTHY_ROLLING_REMAINING = 0.8;
export const STRAINED_ROLLING_REMAINING = 0.05;
/** Verified quota-burn efficiency blend. Applies to Q only, never to H/tier/eligibility. */
export const EFFICIENCY_HEADROOM_WEIGHT = 0.85;
export const EFFICIENCY_EVIDENCE_WEIGHT = 0.15;
