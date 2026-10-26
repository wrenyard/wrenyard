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
/** Full-cycle headroom blend weights (remaining share and cycle-pace term). */
export const FULL_CYCLE_HEADROOM_WEIGHT = 0.5;
export const FULL_CYCLE_RESET_WEIGHT = 0.5;
/**
 * A window at or below this remaining share is insufficient only when it also
 * trails its cycle pace; a balance uses its per-currency low threshold instead.
 */
export const QUOTA_INSUFFICIENT_REMAINING = 0.1;
/** A rolling window (no reset facts, so no pace) is abundant from this share. */
export const ROLLING_ABUNDANT_REMAINING = 0.8;
/** Display and conversion metadata for supported balance units. */
export const BALANCE_UNITS = Object.freeze({
  CNY: { precision: 2, isCurrency: true },
  USD: { precision: 2, isCurrency: true },
  Credits: { precision: 0, isCurrency: false },
  '积分': { precision: 0, isCurrency: false },
} as const);

/** Whole-unit display of a signed decimal string: a true mathematical floor,
 * not truncation, so "60691.4641665000" -> "60691", "0.999" -> "0",
 * "-3.2" -> "-4" and "-0.2" -> "-1". String/BigInt arithmetic only — no
 * Number() conversion — so arbitrarily long decimals never lose precision. */
function floorDecimalInteger(amount: string): string {
  const trimmed = amount.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) return trimmed.length > 0 ? trimmed : '0';
  const negative = match[1] === '-';
  const intPart = match[2].replace(/^0+(?=\d)/, '');
  const fracPart = match[3] ?? '';
  // A non-zero fractional part on a negative value floors one unit lower.
  if (negative && /[1-9]/.test(fracPart)) return `-${(BigInt(intPart) + 1n).toString()}`;
  if (intPart === '0') return '0';
  return negative ? `-${intPart}` : intPart;
}

/** Two-decimal presentation of a decimal-string amount: zero-pads ("12" ->
 * "12.00", "12.3" -> "12.30") and rounds ordinarily ("12.346" -> "12.35").
 * Non-numeric input falls back to the raw string rather than NaN. */
function twoDecimalAmount(amount: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return value.toFixed(2);
}

/**
 * Format a decimal-string amount for one balance unit according to the unit
 * table: precision-0 units floor to a whole number, precision-2 units show
 * exactly two decimals. A unit the table does not know returns the amount
 * unchanged (the provider's precision is kept verbatim).
 */
export function formatBalanceAmount(amount: string, unit: string): string {
  const meta = (BALANCE_UNITS as Record<string, { precision: number; isCurrency: boolean }>)[unit];
  if (meta === undefined) return amount;
  return meta.precision === 0 ? floorDecimalInteger(amount) : twoDecimalAmount(amount);
}
/** How long a last measured state survives a failed or stale read. */
export const QUOTA_EVIDENCE_GRACE_MS = 30 * 60_000;
