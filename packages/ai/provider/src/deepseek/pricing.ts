/**
 * Pure, dependency-free DeepSeek reference-price selector.
 *
 * Reference prices are per 1M tokens and are keyed by model and currency,
 * then by time-of-day tier. Peak windows are HALF-OPEN and UTC on weekdays
 * only (Mon–Fri): [01:00, 04:00) and [06:00, 10:00). An instant at a window
 * start is peak (01:00, 06:00); an instant at a window end is off-peak
 * (04:00, 10:00). Weekends and all remaining hours are off-peak.
 *
 * Passing `through` resolves a CLOSED horizon [at, through] (both endpoints
 * inclusive) and is conservative: the returned per-million fields are the
 * component-wise maxima across every price tuple that is true somewhere in
 * the horizon, with `tier: 'mixed'` unless a single tuple attains all three
 * maxima.
 *
 * The active model is `deepseek-flash`; rates are verified against the
 * official DeepSeek pricing page.
 */

export const DEEPSEEK_REFERENCE_PRICE_SOURCE_URL =
  'https://api-docs.deepseek.com/quick_start/pricing/';
export const DEEPSEEK_REFERENCE_PRICE_CHECKED_AT = '2026-09-10';

/** The only model in the reference price table. */
export type DeepSeekPricingModel = 'deepseek-flash';
/** Currencies the reference price table is published in. */
export type DeepSeekPricingCurrency = 'CNY' | 'USD';
/** Off-peak / peak, or `mixed` when a closed horizon's maxima span tiers. */
export type DeepSeekPricingTier = 'off_peak' | 'peak' | 'mixed';
/** Single-instant lookup vs closed-horizon component-wise maximum lookup. */
export type DeepSeekPricingBasis = 'point_in_time' | 'closed_horizon_max';
/** Anything `Date.parse` understands, plus epoch milliseconds. */
export type DeepSeekPricingInstant = Date | number | string;

/** Immutable resolved reference pricing for a window or instant. */
export interface DeepSeekReferencePricing {
  readonly model: DeepSeekPricingModel;
  readonly currency: DeepSeekPricingCurrency;
  readonly tier: DeepSeekPricingTier;
  readonly basis: DeepSeekPricingBasis;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly inputCacheHitPerMillion: number;
  readonly inputCacheMissPerMillion: number;
  readonly outputPerMillion: number;
  readonly includesPeak: boolean;
  readonly includesOffPeak: boolean;
  readonly sources: readonly string[];
  readonly checkedAt: string;
}

export interface ResolveDeepSeekReferencePricingInput {
  readonly model: DeepSeekPricingModel;
  readonly currency: DeepSeekPricingCurrency;
  readonly at: DeepSeekPricingInstant;
  /** When present the lookup covers the CLOSED horizon [at, through]. */
  readonly through?: DeepSeekPricingInstant;
}

type DeepSeekTierKey = 'off_peak' | 'peak';

interface DeepSeekPerMillionPrice {
  readonly inputCacheHitPerMillion: number;
  readonly inputCacheMissPerMillion: number;
  readonly outputPerMillion: number;
}

interface DeepSeekTierPriceSet {
  readonly off_peak: DeepSeekPerMillionPrice;
  readonly peak: DeepSeekPerMillionPrice;
}

interface DeepSeekCurrencyPriceSet {
  readonly CNY: DeepSeekTierPriceSet;
  readonly USD: DeepSeekTierPriceSet;
}

/** Verified current deepseek-flash tariffs (official DeepSeek pricing page). */
const FLASH_PRICES: DeepSeekCurrencyPriceSet = {
  CNY: {
    off_peak: {
      inputCacheHitPerMillion: 0.02,
      inputCacheMissPerMillion: 1,
      outputPerMillion: 4,
    },
    peak: {
      inputCacheHitPerMillion: 0.04,
      inputCacheMissPerMillion: 2,
      outputPerMillion: 8,
    },
  },
  USD: {
    off_peak: {
      inputCacheHitPerMillion: 0.003,
      inputCacheMissPerMillion: 0.15,
      outputPerMillion: 0.6,
    },
    peak: {
      inputCacheHitPerMillion: 0.006,
      inputCacheMissPerMillion: 0.3,
      outputPerMillion: 1.2,
    },
  },
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Half-open weekday peak windows expressed as UTC time-of-day ranges. */
const PEAK_WINDOWS: ReadonlyArray<{
  readonly startMs: number;
  readonly endMs: number;
}> = [
  { startMs: 1 * HOUR_MS, endMs: 4 * HOUR_MS },
  { startMs: 6 * HOUR_MS, endMs: 10 * HOUR_MS },
];

interface TierPresence {
  readonly peak: boolean;
  readonly offPeak: boolean;
}

interface ApplicableRow extends DeepSeekPerMillionPrice {
  readonly tier: DeepSeekTierKey;
}

function toEpochMs(value: DeepSeekPricingInstant, label: string): number {
  let ms: number;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'number') {
    ms = value;
  } else {
    ms = Date.parse(value);
  }
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      `resolveDeepSeekReferencePricing: "${label}" is not a finite date`
    );
  }
  return ms;
}

/** UTC weekday number of a timestamp: 0 = Sunday ... 6 = Saturday. */
function utcDayOfWeek(ms: number): number {
  return (Math.floor(ms / DAY_MS) + 4) % 7; // 1970-01-01 (Thursday) is 4.
}

/**
 * True when the closed ms range [rangeStartMs, rangeEndMs] intersects the
 * half-open window [windowStartMs, windowEndMs). A range ending exactly at the
 * window end does NOT intersect; a range starting exactly at the window start
 * does.
 */
function intersectsHalfOpen(
  rangeStartMs: number,
  rangeEndMs: number,
  windowStartMs: number,
  windowEndMs: number
): boolean {
  return rangeStartMs < windowEndMs && rangeEndMs >= windowStartMs;
}

/**
 * Detect which tiers occur anywhere inside a closed instant range.
 *
 * The weekday/off-peak schedule is exactly weekly-periodic in UTC, so any
 * range of at least one full week contains both tiers. Shorter ranges touch at
 * most eight distinct UTC dates and are scanned day-by-day.
 */
function tierPresenceInClosedRange(fromMs: number, toMs: number): TierPresence {
  if (toMs - fromMs >= WEEK_MS) {
    return { peak: true, offPeak: true };
  }
  const startDay = Math.floor(fromMs / DAY_MS);
  const endDay = Math.floor(toMs / DAY_MS);
  let peak = false;
  let offPeak = false;
  for (let day = startDay; day <= endDay; day += 1) {
    const dayStartMs = day * DAY_MS;
    const overlapStartMs = Math.max(fromMs, dayStartMs);
    const overlapEndMs = Math.min(toMs, dayStartMs + DAY_MS - 1);
    if (overlapStartMs > overlapEndMs) {
      continue;
    }
    const dow = utcDayOfWeek(dayStartMs);
    if (dow === 0 || dow === 6) {
      // Entire weekend is off-peak.
      offPeak = true;
      continue;
    }
    const todStartMs = overlapStartMs - dayStartMs;
    const todEndMs = overlapEndMs - dayStartMs;
    for (const window of PEAK_WINDOWS) {
      if (
        intersectsHalfOpen(todStartMs, todEndMs, window.startMs, window.endMs)
      ) {
        peak = true;
      }
    }
    // Off-peak is present unless the whole overlap sits inside one peak
    // window (an overlap spanning a window end always reaches off-peak time).
    const whollyInsideOnePeakWindow = PEAK_WINDOWS.some(
      (window) => todStartMs >= window.startMs && todEndMs < window.endMs
    );
    if (!whollyInsideOnePeakWindow) {
      offPeak = true;
    }
  }
  return { peak, offPeak };
}

function priceFor(
  currency: DeepSeekPricingCurrency,
  tier: DeepSeekTierKey
): DeepSeekPerMillionPrice {
  return FLASH_PRICES[currency][tier];
}

/**
 * Resolve DeepSeek reference pricing for an instant or a closed horizon.
 *
 * Without `through` this is a point-in-time lookup at `at`. With `through` the
 * horizon is the CLOSED interval [at, through] (both endpoints included) and
 * the returned price is the component-wise maximum across every price tuple
 * that applies somewhere in that horizon; `tier` is `'mixed'` only when those
 * maxima cannot all be attributed to one single tuple.
 *
 * `model`, `currency`, and the dates are validated; invalid input raises a
 * `RangeError`. Peak windows are half-open (see the module comment).
 */
export function resolveDeepSeekReferencePricing(
  input: ResolveDeepSeekReferencePricingInput
): DeepSeekReferencePricing {
  const { model, currency, at, through } = input;
  if (model !== 'deepseek-flash') {
    throw new RangeError(
      `resolveDeepSeekReferencePricing: unsupported model "${String(model)}"`
    );
  }
  if (currency !== 'CNY' && currency !== 'USD') {
    throw new RangeError(
      `resolveDeepSeekReferencePricing: unsupported currency "${String(
        currency
      )}"`
    );
  }
  const atMs = toEpochMs(at, 'at');
  const throughGiven = through !== undefined;
  const throughMs = throughGiven ? toEpochMs(through, 'through') : atMs;
  if (throughMs < atMs) {
    throw new RangeError(
      'resolveDeepSeekReferencePricing: "through" must be on or after "at"'
    );
  }
  const basis: DeepSeekPricingBasis = throughGiven
    ? 'closed_horizon_max'
    : 'point_in_time';

  const presence = tierPresenceInClosedRange(atMs, throughMs);
  const rows: ApplicableRow[] = [];
  if (presence.offPeak) {
    rows.push({ ...priceFor(currency, 'off_peak'), tier: 'off_peak' });
  }
  if (presence.peak) {
    rows.push({ ...priceFor(currency, 'peak'), tier: 'peak' });
  }

  let maxHit = Number.NEGATIVE_INFINITY;
  let maxMiss = Number.NEGATIVE_INFINITY;
  let maxOutput = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    maxHit = Math.max(maxHit, row.inputCacheHitPerMillion);
    maxMiss = Math.max(maxMiss, row.inputCacheMissPerMillion);
    maxOutput = Math.max(maxOutput, row.outputPerMillion);
  }

  let argmaxTier: DeepSeekPricingTier | null = null;
  for (const row of rows) {
    const rowIsMaximal =
      row.inputCacheHitPerMillion === maxHit &&
      row.inputCacheMissPerMillion === maxMiss &&
      row.outputPerMillion === maxOutput;
    if (!rowIsMaximal) {
      continue;
    }
    if (argmaxTier === null) {
      argmaxTier = row.tier;
    } else if (argmaxTier !== row.tier) {
      argmaxTier = 'mixed';
      break;
    }
  }
  const tier: DeepSeekPricingTier = argmaxTier ?? 'mixed';

  const sources = [DEEPSEEK_REFERENCE_PRICE_SOURCE_URL];

  return Object.freeze<DeepSeekReferencePricing>({
    model,
    currency,
    tier,
    basis,
    windowStart: new Date(atMs).toISOString(),
    windowEnd: new Date(throughMs).toISOString(),
    inputCacheHitPerMillion: maxHit,
    inputCacheMissPerMillion: maxMiss,
    outputPerMillion: maxOutput,
    includesPeak: rows.some((row) => row.tier === 'peak'),
    includesOffPeak: rows.some((row) => row.tier === 'off_peak'),
    sources: Object.freeze(Array.from(new Set(sources))),
    checkedAt: DEEPSEEK_REFERENCE_PRICE_CHECKED_AT,
  });
}
