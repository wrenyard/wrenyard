import type { SupplyAssessment, CandidateScore } from './types.ts';
import { type CandidateInput, type ScoreWeights } from './types.ts';
import { SPEED_SATURATION_BASE_TPS } from './constants.ts';
import { clamp01, interpolatePriceFactor, isFiniteNumber } from './numeric.ts';
/** Computes normalized factors from an admitted candidate and validated evidence. */
export class CandidateScorer {
  score(candidate: CandidateInput, supply: SupplyAssessment, effectiveWeights: ScoreWeights): CandidateScore {
    const { routingPriceUsdPerM, headroom } = supply;
    const expectedTps = candidate.expectedTps;
    const expectedRank = candidate.intelligenceExpectedRank;
    // Equal mean of pool scores, without efficiency bonuses or unknown floors.
    const quotaQuality = clamp01(headroom);
    // Normalized price factor P in [0, 1]. Branch explicitly on the assessed
    // supply class: an explicitly confirmed-free candidate scores the maximum
    // free price factor, while every other candidate uses the fixed continuous
    // price anchors (interpolatePriceFactor) where cheaper per-M output price
    // scores higher and price >= 50 scores 0. Free status is taken from the
    // confirmed-free supply class, never inferred from a numeric zero price.
    const priceFactor = supply.supplyClass === 'confirmed_free'
      ? 1
      : interpolatePriceFactor(routingPriceUsdPerM);
    // Normalized speed factor S in [0, 1]: effective TPS saturated at the global
    // base plus the task's expected TPS. A candidate below the expectation scores
    // proportionally less and one above it keeps gaining until saturation, so the
    // same absolute TPS is worth less to a task that expects a fast model.
    const speedSaturationTps = SPEED_SATURATION_BASE_TPS + (isFiniteNumber(expectedTps) ? expectedTps : 0);
    const speedFactor = clamp01(candidate.effectiveTps / speedSaturationTps);
    // Normalized intelligence factor I in [0, 1]. When an expected rank is
    // supplied (already validated as an integer at or above the minimum), I
    // rewards matching or exceeding it and penalizes deviation: d = model -
    // expected, smaller penalty (0.10 per step) when the model beats expected,
    // larger penalty (0.25 per step) when it falls short. Without an expected
    // rank, I is the model rank normalized over the 0..3 scale.
    let intelligenceFactor: number;
    if (expectedRank !== undefined && expectedRank !== null) {
      const d = candidate.intelligenceRank - expectedRank;
      const penalty = d >= 0 ? 0.1 * d : 0.25 * -d;
      intelligenceFactor = Math.max(0, 1 - penalty);
    }
    else {
      intelligenceFactor = clamp01(candidate.intelligenceRank / 3);
    }
    // Typed intelligence shortfall diagnostic: the distance the model rank falls
    // short of the expected rank (never negative). Absent expected rank keeps the
    // legacy zero shortfall so candidates without an expectation are ordered by
    // score exactly as before.
    const intelligenceShortfall = expectedRank === undefined
      ? 0
      : Math.max(0, expectedRank - candidate.intelligenceRank);
    // Unified normalized ranking score in [0, 1]:
    //   score = weights.P*P + weights.S*S + weights.Q*Q + weights.I*I
    // Every factor is bounded in [0, 1], so the score is itself within [0, 1].
    const score = effectiveWeights.P * priceFactor +
      effectiveWeights.S * speedFactor +
      effectiveWeights.Q * quotaQuality +
      effectiveWeights.I * intelligenceFactor;
    return { quotaQuality, priceFactor, speedFactor, intelligenceFactor, intelligenceShortfall, score };
  }
}
