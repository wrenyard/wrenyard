import { QuotaPolicy } from './quota-policy.ts';
import { SupplyEvidencePolicy } from './supply-evidence-policy.ts';
import { CandidateScorer } from './candidate-scorer.ts';
import { type ExcludedReason, type CandidateEvaluation, type CandidateInput, type ScoreWeights, type QuotaTier, type CandidateAssessment } from './types.ts';
import { snapshotScoreWeights } from './weights.ts';
import { SCORE_WEIGHTS } from './constants.ts';
import { snapshotCandidate } from './candidate-snapshot.ts';
import { isFiniteNumber } from './numeric.ts';
/** Owns admission gates and composes quota, supply evidence and scoring. */
export class CandidateEvaluator {
  constructor(private readonly quota = new QuotaPolicy(), private readonly supply = new SupplyEvidencePolicy(), private readonly scorer = new CandidateScorer()) { }
  private rejected(snapshotId: string, canonicalId: string, reason: ExcludedReason, detail: string | null): CandidateEvaluation {
    return { kind: "rejected", snapshotId, canonicalId, reason, detail };
  }
  evaluate(input: CandidateInput, weights?: ScoreWeights): CandidateEvaluation {
    // Validate weights first so invalid configuration always throws instead of
    // silently falling back to the defaults.
    const effectiveWeights = snapshotScoreWeights(weights ?? SCORE_WEIGHTS);
    if (input === null || typeof input !== "object") {
      return this.rejected("", "", "invalid_candidate", "input is not an object");
    }
    const candidate = snapshotCandidate(input);
    const snapshotId = candidate.snapshotId;
    const canonicalId = candidate.canonicalId;
    if (typeof snapshotId !== "string" || snapshotId.length === 0) {
      return this.rejected(snapshotId, canonicalId, "invalid_candidate", "snapshotId must be a nonempty string");
    }
    if (typeof canonicalId !== "string" || canonicalId.length === 0) {
      return this.rejected(snapshotId, canonicalId, "invalid_candidate", "canonicalId must be a nonempty string");
    }
    if (!isFiniteNumber(candidate.nowMs)) {
      return this.rejected(snapshotId, canonicalId, "invalid_now", "nowMs must be finite");
    }
    if (!isFiniteNumber(candidate.timeoutMs) || candidate.timeoutMs <= 0) {
      return this.rejected(snapshotId, canonicalId, "invalid_timeout", "timeoutMs must be a finite positive duration");
    }
    if (!isFiniteNumber(candidate.referenceUsdPerM) || candidate.referenceUsdPerM < 0) {
      return this.rejected(snapshotId, canonicalId, "invalid_reference_price", "reference price must be finite and non-negative");
    }
    if (!isFiniteNumber(candidate.effectiveCapUsdPerM) || candidate.effectiveCapUsdPerM < 0) {
      return this.rejected(snapshotId, canonicalId, "invalid_cap", "effective cap must be finite and non-negative");
    }
    if (!isFiniteNumber(candidate.minimumTps) ||
      !isFiniteNumber(candidate.effectiveTps) ||
      candidate.minimumTps < 0 ||
      candidate.effectiveTps < 0) {
      return this.rejected(snapshotId, canonicalId, "invalid_speed", "speed numbers must be finite and non-negative");
    }
    const expectedTps = candidate.expectedTps;
    if (expectedTps !== undefined && expectedTps !== null && (!isFiniteNumber(expectedTps) || expectedTps < 0)) {
      return this.rejected(snapshotId, canonicalId, "invalid_speed", "expected TPS is not a finite non-negative number");
    }
    // Only a deficient effectiveTps against the minimumTps hard gate is rejected;
    // the score's speed factor S uses effectiveTps directly (saturated at
    // SPEED_SATURATION_BASE_TPS plus the task's expected TPS).
    if (candidate.effectiveTps < candidate.minimumTps) {
      return this.rejected(snapshotId, canonicalId, "speed_below_minimum", "effective TPS is below the minimum TPS");
    }
    // Intelligence ranks are fixed integers on the closed 0..3 scale. The model
    // rank and any optional expected rank must be integers in [0, 3]; the model
    // rank must additionally meet the intelligence minimum, otherwise the
    // candidate is rejected.
    if (!Number.isInteger(candidate.intelligenceRank) ||
      !Number.isInteger(candidate.intelligenceMinRank) ||
      candidate.intelligenceMinRank < 0 ||
      candidate.intelligenceMinRank > 3) {
      return this.rejected(snapshotId, canonicalId, "invalid_intelligence", "intelligence ranks must be integers in [0, 3]");
    }
    if (candidate.intelligenceRank < candidate.intelligenceMinRank || candidate.intelligenceRank > 3) {
      return this.rejected(snapshotId, canonicalId, "intelligence_out_of_range", "intelligence rank is below the minimum or outside [0, 3]");
    }
    // Hard intelligence floor: intelligenceExpectedRank is absent only when
    // undefined; any other value (including null) must be an integer in [0, 3]
    // and at or above the minimum, or the candidate is rejected before any gate.
    const expectedRank = candidate.intelligenceExpectedRank;
    if (expectedRank !== undefined) {
      if (!Number.isInteger(expectedRank) ||
        expectedRank < 0 ||
        expectedRank > 3 ||
        expectedRank < candidate.intelligenceMinRank) {
        return this.rejected(snapshotId, canonicalId, "invalid_intelligence", "intelligence expected rank must be an integer in [0, 3] at or above the minimum");
      }
    }
    const quota = this.quota.assess(candidate.nowMs, candidate.requiredQuota);
    if (quota.state === "blocked") {
      return this.rejected(snapshotId, canonicalId, "quota_blocked", `blocked constraints: ${quota.blockedConstraintIds.join(",") || "(none)"}`);
    }
    const tier: QuotaTier = quota.state;
    const supply = this.supply.assess(candidate, quota);
    const { notes, supplyClass, confirmedFreeSupplyApplied, confirmedFreeSupplyEvidence, routingPriceUsdPerM, marginalApplied, verifiedEfficiency, headroom, unknownQuotaFloorApplied } = supply;
    const { quotaQuality, priceFactor, speedFactor, intelligenceFactor, intelligenceShortfall, score } = this.scorer.score(candidate, supply, effectiveWeights);
    const assessment: CandidateAssessment = {
      snapshotId,
      canonicalId,
      tier,
      referenceUsdPerM: candidate.referenceUsdPerM,
      routingPriceUsdPerM,
      marginalApplied,
      supplyClass,
      confirmedFreeSupplyApplied,
      confirmedFreeSupplyEvidence,
      unknownQuotaFloorApplied,
      headroom,
      quotaQuality,
      priceFactor,
      speedFactor,
      intelligenceFactor,
      intelligenceShortfall,
      score,
      weights: effectiveWeights,
      verifiedEfficiency,
      coverageComplete: quota.coverageComplete,
      headroomTrusted: quota.headroomTrusted,
      quota,
      notes,
    };
    return { kind: "accepted", assessment };
  }
}
