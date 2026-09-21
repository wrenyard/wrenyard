import { PRICE_FACTOR_ANCHORS } from './constants.ts';
// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function clamp01(value: number): number {
  if (!Number.isFinite(value))
    return 0;
  if (value <= 0)
    return 0;
  if (value >= 1)
    return 1;
  return value;
}
/**
 * Interpolate the normalized price factor P in [0, 1] from PRICE_FACTOR_ANCHORS.
 * Non-positive or non-finite prices score P = 1 (free); prices at or above the
 * final anchor (>= 50) score P = 0; intermediate prices are linearly blended.
 */
export function interpolatePriceFactor(priceUsdPerM: number): number {
  if (!isFiniteNumber(priceUsdPerM) || priceUsdPerM <= 0)
    return 1;
  const lastAnchor = PRICE_FACTOR_ANCHORS[PRICE_FACTOR_ANCHORS.length - 1];
  if (priceUsdPerM >= lastAnchor[0])
    return 0;
  for (let i = 0; i < PRICE_FACTOR_ANCHORS.length - 1; i++) {
    const [p0, v0] = PRICE_FACTOR_ANCHORS[i];
    const [p1, v1] = PRICE_FACTOR_ANCHORS[i + 1];
    if (priceUsdPerM >= p0 && priceUsdPerM <= p1) {
      const t = (priceUsdPerM - p0) / (p1 - p0);
      return v0 + t * (v1 - v0);
    }
  }
  return 0;
}
export function compareLex(a: string, b: string): number {
  if (a < b)
    return -1;
  if (a > b)
    return 1;
  return 0;
}
