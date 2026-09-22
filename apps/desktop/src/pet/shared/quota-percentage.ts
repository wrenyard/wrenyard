/**
 * Convert a quota percentage to its integer display value.
 *
 * Quota bars keep the original fractional precision; only visible percentage
 * text is floored so the UI never claims a higher remaining allowance.
 */
export function floorQuotaPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.floor(Math.min(100, Math.max(0, value)));
}
