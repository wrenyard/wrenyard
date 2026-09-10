import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEEPSEEK_REFERENCE_PRICE_CHECKED_AT,
  DEEPSEEK_REFERENCE_PRICE_SOURCE_URL,
  resolveDeepSeekReferencePricing,
} from '../src/deepseek-pricing.js';
import type {
  DeepSeekPricingBasis,
  DeepSeekPricingCurrency,
  DeepSeekPricingInstant,
  DeepSeekPricingModel,
  DeepSeekPricingTier,
  DeepSeekReferencePricing,
} from '../src/deepseek-pricing.js';

const CURRENT_DOCS = DEEPSEEK_REFERENCE_PRICE_SOURCE_URL;

/**
 * Per-1M tuples are asserted in (inputCacheHit, inputCacheMiss, output) order,
 * matching the module's tables. Every instant is a fixed UTC string, so the
 * suite is fully deterministic: no network, no real clock.
 */
interface ExpectedMeta {
  tier: DeepSeekPricingTier;
  basis: DeepSeekPricingBasis;
  includesPeak: boolean;
  includesOffPeak: boolean;
  sources: readonly string[];
}

type RateCase = readonly [
  instant: string,
  tier: DeepSeekPricingTier,
  hit: number,
  miss: number,
  out: number,
];

function pricing(
  model: DeepSeekPricingModel,
  currency: DeepSeekPricingCurrency,
  at: DeepSeekPricingInstant,
  through?: DeepSeekPricingInstant,
): DeepSeekReferencePricing {
  return resolveDeepSeekReferencePricing({
    model,
    currency,
    at,
    ...(through !== undefined ? { through } : {}),
  });
}

function flashUsd(
  at: DeepSeekPricingInstant,
  through?: DeepSeekPricingInstant,
): DeepSeekReferencePricing {
  return pricing('deepseek-flash', 'USD', at, through);
}

function flashCny(
  at: DeepSeekPricingInstant,
  through?: DeepSeekPricingInstant,
): DeepSeekReferencePricing {
  return pricing('deepseek-flash', 'CNY', at, through);
}

function assertMeta(result: DeepSeekReferencePricing, expected: ExpectedMeta): void {
  assert.equal(result.tier, expected.tier);
  assert.equal(result.basis, expected.basis);
  assert.equal(result.includesPeak, expected.includesPeak);
  assert.equal(result.includesOffPeak, expected.includesOffPeak);
  assert.deepEqual([...result.sources], [...expected.sources]);
}

function assertRate(
  result: DeepSeekReferencePricing,
  hit: number,
  miss: number,
  out: number,
): void {
  assert.equal(result.inputCacheHitPerMillion, hit);
  assert.equal(result.inputCacheMissPerMillion, miss);
  assert.equal(result.outputPerMillion, out);
}

/** Point lookup asserting tier, rate, flags, and source. */
function assertPoint(rateCase: RateCase): void {
  const [instant, tier, hit, miss, out] = rateCase;
  const result = flashUsd(instant);
  assertMeta(result, {
    tier,
    basis: 'point_in_time',
    includesPeak: tier === 'peak',
    includesOffPeak: tier === 'off_peak',
    sources: [CURRENT_DOCS],
  });
  assertRate(result, hit, miss, out);
}

describe('resolveDeepSeekReferencePricing', () => {
  it('rejects invalid models, currencies, non-finite dates, and a reversed horizon', () => {
    // Retired DeepSeek model ids are no longer priced.
    assert.throws(
      () =>
        pricing('deepseek-v4-flash' as DeepSeekPricingModel, 'USD', '2026-09-10T04:00:00.000Z'),
      RangeError,
    );
    assert.throws(
      () =>
        pricing('deepseek-v4-pro' as DeepSeekPricingModel, 'USD', '2026-09-10T04:00:00.000Z'),
      RangeError,
    );
    assert.throws(
      () =>
        pricing('deepseek-flash', 'EUR' as DeepSeekPricingCurrency, '2026-09-10T04:00:00.000Z'),
      RangeError,
    );
    assert.throws(() => flashUsd('not-a-date'), RangeError);
    assert.throws(() => flashUsd(''), RangeError);
    assert.throws(() => flashUsd(new Date(NaN)), RangeError);
    assert.throws(() => flashUsd(NaN), RangeError);
    assert.throws(
      () => flashUsd('2026-09-10T04:00:00.000Z', '2026-09-10T03:59:59.999Z'),
      RangeError,
    );
  });

  it('flash USD peak endpoints are half-open: starts are peak, ends off-peak', () => {
    // Monday 2026-09-14 is a normal weekday after the retired pre-cut era.
    const cases: readonly RateCase[] = [
      ['2026-09-14T01:00:00.000Z', 'peak', 0.006, 0.3, 1.2], // [01:00, 04:00) start is peak
      ['2026-09-14T04:00:00.000Z', 'off_peak', 0.003, 0.15, 0.6], // window end exclusive
      ['2026-09-14T06:00:00.000Z', 'peak', 0.006, 0.3, 1.2], // [06:00, 10:00) start is peak
      ['2026-09-14T10:00:00.000Z', 'off_peak', 0.003, 0.15, 0.6], // window end exclusive
    ];
    for (const rateCase of cases) {
      assertPoint(rateCase);
    }
  });

  it('tiers by day: Friday peak, weekend off-peak, next Monday peak', () => {
    const cases: readonly RateCase[] = [
      ['2026-09-11T01:00:00.000Z', 'peak', 0.006, 0.3, 1.2], // Friday
      ['2026-09-12T01:00:00.000Z', 'off_peak', 0.003, 0.15, 0.6], // Saturday
      ['2026-09-13T06:00:00.000Z', 'off_peak', 0.003, 0.15, 0.6], // Sunday
      ['2026-09-14T06:00:00.000Z', 'peak', 0.006, 0.3, 1.2], // next Monday
    ];
    for (const rateCase of cases) {
      assertPoint(rateCase);
    }
  });

  it('flash CNY off-peak and peak rates', () => {
    const offPeak = flashCny('2026-09-14T00:00:00.000Z');
    assertMeta(offPeak, {
      tier: 'off_peak',
      basis: 'point_in_time',
      includesPeak: false,
      includesOffPeak: true,
      sources: [CURRENT_DOCS],
    });
    assertRate(offPeak, 0.02, 1, 4);

    const peak = flashCny('2026-09-14T06:00:00.000Z');
    assertMeta(peak, {
      tier: 'peak',
      basis: 'point_in_time',
      includesPeak: true,
      includesOffPeak: false,
      sources: [CURRENT_DOCS],
    });
    assertRate(peak, 0.04, 2, 8);
  });

  describe('closed horizons', () => {
    it('a horizon from Friday 10:00 through Monday 01:00 includes the Monday peak endpoint', () => {
      const at = '2026-09-11T10:00:00.000Z'; // Friday off-peak (window end exclusive)
      const through = '2026-09-14T01:00:00.000Z'; // Monday window start inclusive
      const result = flashUsd(at, through);
      assertMeta(result, {
        tier: 'peak',
        basis: 'closed_horizon_max',
        includesPeak: true,
        includesOffPeak: true,
        sources: [CURRENT_DOCS],
      });
      assertRate(result, 0.006, 0.3, 1.2);
      assert.equal(result.windowEnd, through);
    });

    it('a closed horizon ending at 06:00 includes the peak endpoint', () => {
      const result = flashUsd('2026-09-14T04:00:00.000Z', '2026-09-14T06:00:00.000Z');
      assertMeta(result, {
        tier: 'peak',
        basis: 'closed_horizon_max',
        includesPeak: true,
        includesOffPeak: true,
        sources: [CURRENT_DOCS],
      });
      assertRate(result, 0.006, 0.3, 1.2);
    });

    it('the same window ending one millisecond before 06:00 stays off-peak', () => {
      const result = flashUsd('2026-09-14T04:00:00.000Z', '2026-09-14T05:59:59.999Z');
      assertMeta(result, {
        tier: 'off_peak',
        basis: 'closed_horizon_max',
        includesPeak: false,
        includesOffPeak: true,
        sources: [CURRENT_DOCS],
      });
      assertRate(result, 0.003, 0.15, 0.6);
    });

    it('a weekend-only horizon stays off-peak', () => {
      const result = flashUsd('2026-09-12T00:00:00.000Z', '2026-09-13T23:59:59.999Z');
      assertMeta(result, {
        tier: 'off_peak',
        basis: 'closed_horizon_max',
        includesPeak: false,
        includesOffPeak: true,
        sources: [CURRENT_DOCS],
      });
      assertRate(result, 0.003, 0.15, 0.6);
    });

    it('a >= 1 week horizon covers both tiers with the peak maximum', () => {
      const result = flashUsd('2026-09-10T04:00:00.000Z', '2026-09-17T04:00:00.000Z');
      assertMeta(result, {
        tier: 'peak',
        basis: 'closed_horizon_max',
        includesPeak: true,
        includesOffPeak: true,
        sources: [CURRENT_DOCS],
      });
      assertRate(result, 0.006, 0.3, 1.2);
    });
  });

  it('reports checkedAt 2026-09-10 and returns frozen, deduplicated sources', () => {
    const results = [
      flashUsd('2026-09-14T01:00:00.000Z'),
      flashUsd('2026-09-14T04:00:00.000Z'),
      flashUsd('2026-09-14T00:00:00.000Z', '2026-09-14T06:00:00.000Z'),
      flashCny('2026-09-14T06:00:00.000Z'),
    ];
    for (const result of results) {
      assert.equal(result.checkedAt, '2026-09-10');
      assert.equal(result.checkedAt, DEEPSEEK_REFERENCE_PRICE_CHECKED_AT);
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.sources));
      assert.equal(new Set(result.sources).size, result.sources.length);
    }
    const single = flashUsd('2026-09-14T01:00:00.000Z');
    assert.deepEqual([...single.sources], [CURRENT_DOCS]);
  });
});
