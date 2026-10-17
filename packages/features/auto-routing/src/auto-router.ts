import { CandidateEvaluator } from './candidate-evaluator.ts';
import { type CandidateAssessment, type RankedCandidate, type CandidateInput, type ScoreWeights, type AutoRoutingResult, type ExcludedCandidate } from './types.ts';
import { snapshotScoreWeights } from './weights.ts';
import { SCORE_WEIGHTS } from './constants.ts';
import { compareLex } from './numeric.ts';
/** Abundant supply: confirmed free, or healthy quota carrying trusted headroom. */
export function isAbundantSupply(assessment: Pick<CandidateAssessment, 'supplyClass' | 'quota' | 'headroomTrusted'>): boolean {
  return assessment.supplyClass === 'confirmed_free' ||
    (assessment.quota.state === 'healthy' && assessment.headroomTrusted);
}
/** Abundant supply ranks ahead of every other eligible route as a priority tier. */
function supplyTier(assessment: CandidateAssessment): number {
  return isAbundantSupply(assessment) ? 0 : 1;
}
/** Evaluates one immutable candidate set and applies deterministic ranking. */
export class AutoRouter {
  constructor(private readonly evaluator = new CandidateEvaluator()) { }
  private toRankedCandidate(assessment: CandidateAssessment, rank: number): RankedCandidate {
    return {
      rank,
      snapshotId: assessment.snapshotId,
      canonicalId: assessment.canonicalId,
      tier: assessment.tier,
      score: assessment.score,
      referenceUsdPerM: assessment.referenceUsdPerM,
      routingPriceUsdPerM: assessment.routingPriceUsdPerM,
      marginalApplied: assessment.marginalApplied,
      supplyClass: assessment.supplyClass,
      confirmedFreeSupplyApplied: assessment.confirmedFreeSupplyApplied,
      confirmedFreeSupplyEvidence: assessment.confirmedFreeSupplyEvidence,
      headroom: assessment.headroom,
      quotaQuality: assessment.quotaQuality,
      priceFactor: assessment.priceFactor,
      speedFactor: assessment.speedFactor,
      intelligenceFactor: assessment.intelligenceFactor,
      intelligenceShortfall: assessment.intelligenceShortfall,
      weights: assessment.weights,
      coverageComplete: assessment.coverageComplete,
      headroomTrusted: assessment.headroomTrusted,
      quota: assessment.quota,
      notes: assessment.notes,
    };
  }
  rank(inputs: readonly CandidateInput[], weights?: ScoreWeights): AutoRoutingResult {
    // Validate weights first so invalid configuration always throws instead of
    // silently falling back to the defaults.
    const effectiveWeights = snapshotScoreWeights(weights ?? SCORE_WEIGHTS);
    if (inputs === null || typeof inputs !== "object" || !Array.isArray(inputs)) {
      return { ranked: [], excluded: [] };
    }
    const accepted: CandidateAssessment[] = [];
    const excluded: ExcludedCandidate[] = [];
    // One immutable selection context: ranking mixes only candidates sharing the
    // snapshotId/nowMs of the first valid (accepted) input.
    let contextSnapshotId: string | null = null;
    let contextNowMs: number | null = null;
    for (const input of inputs) {
      const evaluation = this.evaluator.evaluate(input, effectiveWeights);
      if (evaluation.kind === "accepted") {
        const assessment = evaluation.assessment;
        if (contextSnapshotId === null) {
          contextSnapshotId = input.snapshotId;
          contextNowMs = input.nowMs;
        }
        if (input.snapshotId !== contextSnapshotId ||
          input.nowMs !== contextNowMs) {
          excluded.push({
            snapshotId: assessment.snapshotId,
            canonicalId: assessment.canonicalId,
            reason: "snapshot_context_mismatch",
            detail: `expected snapshotId=${contextSnapshotId}, nowMs=${contextNowMs}`,
          });
          continue;
        }
        accepted.push(assessment);
      }
      else {
        excluded.push({
          snapshotId: evaluation.snapshotId,
          canonicalId: evaluation.canonicalId,
          reason: evaluation.reason,
          detail: evaluation.detail,
        });
      }
    }
    excluded.sort((a, b) => compareLex(a.canonicalId, b.canonicalId) ||
      compareLex(a.snapshotId, b.snapshotId));
    // Abundant supply (confirmed free or healthy quota with trusted headroom)
    // forms its own priority tier ahead of every other eligible route; inside
    // each tier the weighted total score ranks candidates, then stable identity
    // breaks ties. Recommendation affects the intelligence factor; shortfall
    // remains a diagnostic and is never an independent ranking priority.
    const rankedAssessments = accepted.slice().sort((a, b) =>
      supplyTier(a) - supplyTier(b) ||
      b.score - a.score ||
      compareLex(a.canonicalId, b.canonicalId) ||
      compareLex(a.snapshotId, b.snapshotId));
    const selected = rankedAssessments[0];
    if (selected !== undefined && selected.intelligenceShortfall > 0) {
      selected.notes.push('intelligence_below_expected');
    }
    const ranked: RankedCandidate[] = rankedAssessments.map((assessment, index) => this.toRankedCandidate(assessment, index + 1));
    return { ranked, excluded };
  }
}
