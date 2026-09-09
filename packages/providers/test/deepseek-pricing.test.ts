import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEEPSEEK_FLASH_PRICE_CHANGE_NOTICE_URL,
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
const CHANGE_NOTICE = DEEPSEEK_FLASH_PRICE_CHANGE_NOTICE_URL;

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
  includesFlashPriceChange: boolean;
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
  return pricing('deepseek-v4-flash', 'USD', at, through);
}

function flashCny(
  at: DeepSeekPricingInstant,
  through?: DeepSeekPricingInstant,
): DeepSeekReferencePricing {
  return pricing('deepseek-v4-flash', 'CNY', at, through);
}

function proUsd(at: DeepSeekPricingInstant): DeepSeekReferencePricing {
  return pricing('deepseek-v4-pro', 'USD', at);
}

function proCny(at: DeepSeekPricingInstant): DeepSeekReferencePricing {
  return pricing('deepseek-v4-pro', 'CNY', at);
}

function assertMeta(result: DeepSeekReferencePricing, expected: ExpectedMeta): void {
  assert.equal(result.tier, expected.tier);
  assert.equal(result.basis, expected.basis);
  assert.equal(result.includesPeak, expected.includesPeak);
  assert.equal(result.includesOffPeak, expected.includesOffPeak);
  assert.equal(result.includesFlashPriceChange, expected.includesFlashPriceChange);
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

/** Point lookup on post-cut flash USD, asserting tier, rate, flag, and source. */
function assertPostCutPoint(rateCase: RateCase): void {
  const [instant, tier, hit, miss, out] = rateCase;
  const result = flashUsd(instant);
  assertMeta(result, {
    tier,
    basis: 'point_in_time',
    includesPeak: tier === 'peak',
    includesOffPeak: tier === 'off_peak',
    includesFlashPriceChange: true,
    sources: [CHANGE_NOTICE],
  });
  assertRate(result, hit, miss, out);
}

describe('resolveDeepSeekReferencePricing', () => {
  it('rejects non-finite dates and a reversed horizon with RangeError', () => {
    assert.throws(() => flashUsd('not-a-date'), RangeError);
    assert.throws(() => flashUsd(''), RangeError);
    assert.throws(() => flashUsd(new Date(NaN)), RangeError);
    assert.throws(() => flashUsd(NaN), RangeError);
    assert.throws(
      () => flashUsd('2026-09-10T04:00:00.000Z', '2026-09-10T03:59:59.999Z'),
      RangeError,
    );
  });

  it('flash USD just before the cut uses the old weekday-peak table', () => {
    const instant = '2026-09-10T03:59:59.999Z'; // Thursday, peak window [01:00, 04:00)
    const result = flashUsd(instant);
    assert.equal(result.model, 'deepseek-v4-flash');
    assert.equal(result.currency, 'USD');
    assertMeta(result, {
      tier: 'peak',
      basis: 'point_in_time',
      includesPeak: true,
      includesOffPeak: false,
      includesFlashPriceChange: false,
      sources: [CURRENT_DOCS],
    });
    assertRate(result, 0.014, 0.44, 1.32);
    assert.equal(result.windowStart, instant);
    assert.equal(result.windowEnd, instant);
  });

  it('flash USD switches to the new table exactly at and just after the cut', () => {
    for (const instant of ['2026-09-10T04:00:00.000Z', '2026-09-10T04:00:00.001Z']) {
      const result = flashUsd(instant);
      assertMeta(result, {
        tier: 'off_peak',
        basis: 'point_in_time',
        includesPeak: false,
        includesOffPeak: true,
        includesFlashPriceChange: true,
        sources: [CHANGE_NOTICE],
      });
      assertRate(result, 0.003, 0.15, 0.6);
    }
  });

  it('keeps post-cut weekday windows half-open: starts are peak, ends off-peak', () => {
    // Monday 2026-09-14 lies entirely after the Thursday cut.
    const cases: readonly RateCase[] = [
      ['2026-09-14T01:00:00.000Z', 'peak', 0.006, 0.3, 1.2], // [01:00, 04:00) start is peak
      ['2026-09-14T04:00:00.000Z', 'off_peak', 0.003, 0.15, 0.6], // window end exclusive
      ['2026-09-14T06:00:00.000Z', 'peak', 0.006, 0.3, 1.2], // [06:00, 10:00) start is peak
      ['2026-09-14T10:00:00.000Z', 'off_peak', 0.003, 0.15, 0.6], // window end exclusive
    ];
    for (const rateCase of cases) {
      assertPostCutPoint(rateCase);
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
      assertPostCutPoint(rateCase);
    }
  });

  it('flash CNY: exact pre/post-cut off-peak and post-cut peak rates', () => {
    const preCut = flashCny('2026-09-10T00:00:00.000Z'); // pre-cut off-peak
    assertMeta(preCut, {
      tier: 'off_peak',
      basis: 'point_in_time',
      includesPeak: false,
      includesOffPeak: true,
      includesFlashPriceChange: false,
      sources: [CURRENT_DOCS],
    });
    assertRate(preCut, 0.05, 1.5, 4.5);

    const postOffPeak = flashCny('2026-09-10T04:00:00.000Z'); // exact cut instant
    assertMeta(postOffPeak, {
      tier: 'off_peak',
      basis: 'point_in_time',
      includesPeak: false,
      includesOffPeak: true,
      includesFlashPriceChange: true,
      sources: [CHANGE_NOTICE],
    });
    assertRate(postOffPeak, 0.02, 1, 4);

    const postPeak = flashCny('2026-09-10T06:00:00.000Z');
    assertMeta(postPeak, {
      tier: 'peak',
      basis: 'point_in_time',
      includesPeak: true,
      includesOffPeak: false,
      includesFlashPriceChange: true,
      sources: [CHANGE_NOTICE],
    });
    assertRate(postPeak, 0.04, 2, 8);
  });

  it('pro USD is unchanged across the flash cut while its tier follows the clock', () => {
    const peakBefore = proUsd('2026-09-10T03:00:00.000Z');
    const peakAfter = proUsd('2026-09-10T06:00:00.000Z');
    const offPeakBefore = proUsd('2026-09-10T00:00:00.000Z');
    const offPeakAtCut = proUsd('2026-09-10T04:00:00.000Z');
    const offPeakAfter = proUsd('2026-09-10T05:00:00.000Z');
    for (const result of [peakBefore, peakAfter]) {
      assertMeta(result, {
        tier: 'peak',
        basis: 'point_in_time',
        includesPeak: true,
        includesOffPeak: false,
        includesFlashPriceChange: false,
        sources: [CURRENT_DOCS],
      });
      assertRate(result, 0.044, 1.32, 3.96);
    }
    for (const result of [offPeakBefore, offPeakAtCut, offPeakAfter]) {
      assertMeta(result, {
        tier: 'off_peak',
        basis: 'point_in_time',
        includesPeak: false,
        includesOffPeak: true,
        includesFlashPriceChange: false,
        sources: [CURRENT_DOCS],
      });
      assertRate(result, 0.022, 0.66, 1.98);
    }
  });

  it('pro CNY is unchanged across the flash cut while its tier follows the clock', () => {
    const peakBefore = proCny('2026-09-10T03:00:00.000Z');
    const peakAfter = proCny('2026-09-10T06:00:00.000Z');
    const offPeakBefore = proCny('2026-09-10T00:00:00.000Z');
    const offPeakAtCut = proCny('2026-09-10T04:00:00.000Z');
    const offPeakAfter = proCny('2026-09-10T05:00:00.000Z');
    for (const result of [peakBefore, peakAfter]) {
      assertMeta(result, {
        tier: 'peak',
        basis: 'point_in_time',
        includesPeak: true,
        includesOffPeak: false,
        includesFlashPriceChange: false,
        sources: [CURRENT_DOCS],
      });
      assertRate(result, 0.3, 9, 27);
    }
    for (const result of [offPeakBefore, offPeakAtCut, offPeakAfter]) {
      assertMeta(result, {
        tier: 'off_peak',
        basis: 'point_in_time',
        includesPeak: false,
        includesOffPeak: true,
        includesFlashPriceChange: false,
        sources: [CURRENT_DOCS],
      });
      assertRate(result, 0.15, 4.5, 13.5);
    }
  });

  describe('closed horizons', () => {
    it('a horizon through the cut instant returns the conservative old-peak maximum', () => {
      const at = '2026-09-10T03:59:59.999Z';
      const through = '2026-09-10T04:00:00.000Z';
      const result = flashUsd(at, through);
      assertMeta(result, {
        tier: 'peak',
        basis: 'closed_horizon_max',
        includesPeak: true,
        includesOffPeak: true,
        includesFlashPriceChange: true,
        sources: [CURRENT_DOCS, CHANGE_NOTICE],
      });
      assertRate(result, 0.014, 0.44, 1.32);
      assert.equal(result.windowStart, at);
      assert.equal(result.windowEnd, through);
    });

    it('a closed horizon ending at 06:00 includes the peak endpoint', () => {
      const result = flashUsd('2026-09-10T04:00:00.000Z', '2026-09-10T06:00:00.000Z');
      assertMeta(result, {
        tier: 'peak',
        basis: 'closed_horizon_max',
        includesPeak: true,
        includesOffPeak: true,
        includesFlashPriceChange: true,
        sources: [CHANGE_NOTICE],
      });
      assertRate(result, 0.006, 0.3, 1.2);
    });

    it('the same window ending one millisecond before 06:00 stays off-peak', () => {
      const result = flashUsd('2026-09-10T04:00:00.000Z', '2026-09-10T05:59:59.999Z');
      assertMeta(result, {
        tier: 'off_peak',
        basis: 'closed_horizon_max',
        includesPeak: false,
        includesOffPeak: true,
        includesFlashPriceChange: true,
        sources: [CHANGE_NOTICE],
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
        includesFlashPriceChange: true,
        sources: [CHANGE_NOTICE],
      });
      assertRate(result, 0.003, 0.15, 0.6);
    });

    it('a horizon from Friday 10:00 through Monday 01:00 includes the Monday peak endpoint', () => {
      const at = '2026-09-11T10:00:00.000Z'; // Friday off-peak (window end exclusive)
      const through = '2026-09-14T01:00:00.000Z'; // Monday window start inclusive
      const result = flashUsd(at, through);
      assertMeta(result, {
        tier: 'peak',
        basis: 'closed_horizon_max',
        includesPeak: true,
        includesOffPeak: true,
        includesFlashPriceChange: true,
        sources: [CHANGE_NOTICE],
      });
      assertRate(result, 0.006, 0.3, 1.2);
      assert.equal(result.windowEnd, through);
    });

    it('a horizon spanning pre-cut off-peak and post-cut peak resolves to the real old-peak tuple', () => {
      // 2026-09-10T00:00Z → 06:00Z covers pre-cut off-peak and post-cut peak,
      // but it MUST also contain the intervening old peak [01:00, 04:00), which
      // dominates every component. A mixed .007/.30/1.2 snapshot is temporally
      // impossible, so the conservative maximum is exactly the old peak tuple.
      const result = flashUsd('2026-09-10T00:00:00.000Z', '2026-09-10T06:00:00.000Z');
      assertMeta(result, {
        tier: 'peak',
        basis: 'closed_horizon_max',
        includesPeak: true,
        includesOffPeak: true,
        includesFlashPriceChange: true,
        sources: [CURRENT_DOCS, CHANGE_NOTICE],
      });
      assertRate(result, 0.014, 0.44, 1.32);
      assert.notDeepEqual(
        [
          result.inputCacheHitPerMillion,
          result.inputCacheMissPerMillion,
          result.outputPerMillion,
        ],
        [0.007, 0.3, 1.2],
      );
    });
  });

  it('reports checkedAt 2026-09-09 and returns frozen, deduplicated sources', () => {
    const results = [
      flashUsd('2026-09-10T03:59:59.999Z'),
      flashUsd('2026-09-10T04:00:00.000Z'),
      flashUsd('2026-09-10T00:00:00.000Z', '2026-09-10T06:00:00.000Z'),
      proCny('2026-09-10T03:00:00.000Z'),
    ];
    for (const result of results) {
      assert.equal(result.checkedAt, '2026-09-09');
      assert.equal(result.checkedAt, DEEPSEEK_REFERENCE_PRICE_CHECKED_AT);
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.sources));
      assert.equal(new Set(result.sources).size, result.sources.length);
    }
    // A spanning horizon carries both provenance URLs exactly once each.
    const spanning = flashUsd('2026-09-10T00:00:00.000Z', '2026-09-10T06:00:00.000Z');
    assert.deepEqual([...spanning.sources], [CURRENT_DOCS, CHANGE_NOTICE]);
  });
});
