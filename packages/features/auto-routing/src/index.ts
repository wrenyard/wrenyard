export * from './types.ts';
export { SCORE_WEIGHTS, PRICE_FACTOR_ANCHORS, SPEED_SATURATION_BASE_TPS, ZERO_QUOTA_HEADROOM, UNKNOWN_QUOTA_FLOOR_HEADROOM, FULL_CYCLE_MIN_REMAINING, FULL_CYCLE_RESET_PACE, FULL_CYCLE_HEADROOM_WEIGHT, FULL_CYCLE_RESET_WEIGHT, HEALTHY_ROLLING_REMAINING, STRAINED_ROLLING_REMAINING, EFFICIENCY_HEADROOM_WEIGHT, EFFICIENCY_EVIDENCE_WEIGHT } from './constants.ts';
export { validateScoreWeights } from './weights.ts';
export { AutoRouter } from './auto-router.ts';
export { QuotaPolicy } from './quota-policy.ts';
export { SupplyEvidencePolicy } from './supply-evidence-policy.ts';
export { CandidateScorer } from './candidate-scorer.ts';
export { CandidateEvaluator } from './candidate-evaluator.ts';
export { ConstrainedDispatcher, isDynamicFast } from './constrained-dispatcher.ts';
import { AutoRouter } from './auto-router.ts';
import { QuotaPolicy } from './quota-policy.ts';
import { CandidateEvaluator } from './candidate-evaluator.ts';
import { ConstrainedDispatcher } from './constrained-dispatcher.ts';
import type { Catalog } from '@wrenyard/catalog';
import type { CandidateInput, ScoreWeights, RequiredQuotaConstraint } from './types.ts';
import type { DispatchCandidate, LocalSpeedSample } from '@wrenyard/catalog';
import type { TaskDispatchRequirements } from './types.ts';
export function assessRequiredQuota(nowMs: number, constraints: readonly RequiredQuotaConstraint[]) {
  return new QuotaPolicy().assess(nowMs, constraints);
}
export function evaluateCandidate(input: CandidateInput, weights?: ScoreWeights) {
  return new CandidateEvaluator().evaluate(input, weights);
}
export function rankAutoRoutingCandidates(inputs: readonly CandidateInput[], weights?: ScoreWeights) {
  return new AutoRouter().rank(inputs, weights);
}
export function resolveConstrainedDispatch(catalog: Catalog, candidates: readonly DispatchCandidate[], requirements: TaskDispatchRequirements, localSpeed?: readonly LocalSpeedSample[]) {
  return new ConstrainedDispatcher(catalog).resolve(candidates, requirements, localSpeed);
}
