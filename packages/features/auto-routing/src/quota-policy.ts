import { type BalanceEvidence, type ConstraintAssessment, type RequiredQuotaConstraint, type ConstraintRejectCode, type ConstraintState, type QuotaAssessment, type QuotaState } from './types.ts';
import { isFiniteNumber } from './numeric.ts';
import { FULL_CYCLE_MIN_REMAINING, FULL_CYCLE_RESET_PACE, FULL_CYCLE_HEADROOM_WEIGHT, FULL_CYCLE_RESET_WEIGHT, HEALTHY_ROLLING_REMAINING, STRAINED_ROLLING_REMAINING, ZERO_QUOTA_HEADROOM } from './constants.ts';
/** Validates quota/balance evidence and aggregates required resource constraints. */
export class QuotaPolicy {
  private assessBalanceConstraint(nowMs: number, id: string, balance: BalanceEvidence | null | undefined): ConstraintAssessment {
    if (balance === null || balance === undefined || typeof balance !== "object") {
      return { id, state: "missing", headroom: null, rejectCode: null };
    }
    if (!isFiniteNumber(nowMs)) {
      return { id, state: "rejected", headroom: null, rejectCode: "invalid_now" };
    }
    const observedAtMs = balance.observedAtMs;
    if (!isFiniteNumber(observedAtMs)) {
      return { id, state: "rejected", headroom: null, rejectCode: "observation_time_not_finite" };
    }
    if (observedAtMs > nowMs) {
      return { id, state: "rejected", headroom: null, rejectCode: "future_observation" };
    }
    const validForMs = balance.validForMs;
    if (!isFiniteNumber(validForMs) || validForMs <= 0) {
      return { id, state: "rejected", headroom: null, rejectCode: "invalid_freshness_window" };
    }
    if (nowMs - observedAtMs > validForMs) {
      return { id, state: "rejected", headroom: null, rejectCode: "stale_observation" };
    }
    // Validate decimal syntax and test exact zero without floating-point loss.
    const amount = balance.amount;
    if (typeof amount !== "string" || !/^\d+(?:\.\d+)?$/.test(amount)) {
      return { id, state: "rejected", headroom: null, rejectCode: "invalid_balance_amount" };
    }
    if (!/[1-9]/.test(amount)) {
      return { id, state: "blocked", headroom: 0, rejectCode: null };
    }
    // amount > 0: available, no trusted headroom, never a subscription-pace boost.
    return { id, state: "healthy", headroom: null, rejectCode: null };
  }
  private assessConstraint(nowMs: number, constraint: RequiredQuotaConstraint): ConstraintAssessment {
    if (constraint === null || typeof constraint !== "object") {
      return { id: "", state: "missing", headroom: null, rejectCode: null };
    }
    const id = typeof constraint.id === "string" ? constraint.id : "";
    const balance = constraint.balance;
    if (constraint.kind === "balance" || balance != null) {
      return this.assessBalanceConstraint(nowMs, id, balance);
    }
    const evidence = constraint.evidence;
    if (evidence === null || evidence === undefined || typeof evidence !== "object") {
      return { id, state: "missing", headroom: null, rejectCode: null };
    }
    if (!isFiniteNumber(nowMs)) {
      return { id, state: "rejected", headroom: null, rejectCode: "invalid_now" };
    }
    const reject = (rejectCode: ConstraintRejectCode): ConstraintAssessment => ({
      id,
      state: "rejected",
      headroom: null,
      rejectCode,
    });
    const remainingPercent = evidence.remainingPercent;
    if (!isFiniteNumber(remainingPercent)) {
      return reject("remaining_percent_not_finite");
    }
    if (remainingPercent < 0 || remainingPercent > 100) {
      return reject("remaining_percent_out_of_range");
    }
    const observedAtMs = evidence.observedAtMs;
    if (!isFiniteNumber(observedAtMs)) {
      return reject("observation_time_not_finite");
    }
    // Reject future observations: a decision cannot use evidence from later than now.
    if (observedAtMs > nowMs) {
      return reject("future_observation");
    }
    const validForMs = evidence.validForMs;
    if (!isFiniteNumber(validForMs) || validForMs <= 0) {
      return reject("invalid_freshness_window");
    }
    // Reject stale evidence outright; never treat stale values as healthy.
    if (nowMs - observedAtMs > validForMs) {
      return reject("stale_observation");
    }
    const replenishmentKind = evidence.replenishmentKind;
    if (replenishmentKind !== "full_cycle" &&
      replenishmentKind !== "rolling_partial" &&
      replenishmentKind !== "unknown") {
      return reject("invalid_replenishment_kind");
    }
    const remainingRatio = remainingPercent / 100;
    // Fresh remaining of exactly zero blocks: no headroom at all.
    if (remainingRatio === 0) {
      return { id, state: "blocked", headroom: 0, rejectCode: null };
    }
    if (replenishmentKind === "full_cycle") {
      const resetAtMs = evidence.resetAtMs;
      const windowMs = evidence.windowMs;
      if (!isFiniteNumber(resetAtMs) || resetAtMs <= nowMs) {
        return reject("invalid_reset_time");
      }
      if (!isFiniteNumber(windowMs) || windowMs <= 0) {
        return reject("invalid_cycle_duration");
      }
      const resetHorizonMs = resetAtMs - nowMs;
      // The reset horizon must be a positive span no longer than the declared cycle.
      if (resetHorizonMs <= 0 || resetHorizonMs > windowMs) {
        return reject("reset_horizon_beyond_duration");
      }
      const expectedRemaining = resetHorizonMs / windowMs;
      const healthyThreshold = Math.max(FULL_CYCLE_MIN_REMAINING, FULL_CYCLE_RESET_PACE * expectedRemaining);
      const paceTerm = Math.min(1, remainingRatio / Math.max(expectedRemaining, FULL_CYCLE_MIN_REMAINING));
      const headroom = FULL_CYCLE_HEADROOM_WEIGHT * remainingRatio +
        FULL_CYCLE_RESET_WEIGHT * paceTerm;
      const state: ConstraintState = remainingRatio >= healthyThreshold ? "healthy" : "strained";
      return { id, state, headroom, rejectCode: null };
    }
    if (replenishmentKind === "rolling_partial") {
      if (remainingRatio >= HEALTHY_ROLLING_REMAINING) {
        return { id, state: "healthy", headroom: remainingRatio, rejectCode: null };
      }
      if (remainingRatio > 0 && remainingRatio < STRAINED_ROLLING_REMAINING) {
        return { id, state: "strained", headroom: remainingRatio, rejectCode: null };
      }
      // Middle band [0.05, 0.80): genuinely unknown headroom contributes zero.
      return { id, state: "unknown", headroom: null, rejectCode: null };
    }
    // Unknown replenishment kind stays unknown.
    return { id, state: "unknown", headroom: null, rejectCode: null };
  }
  assess(nowMs: number, constraints: readonly RequiredQuotaConstraint[]): QuotaAssessment {
    // An empty (or non-array) constraint list is not covered quota evidence.
    const list = Array.isArray(constraints) ? constraints : [];
    const assessments: ConstraintAssessment[] = [];
    let hasBlocked = false;
    let hasStrained = false;
    let hasUnknown = false;
    let hasMissingOrRejected = false;
    const blockedConstraintIds: string[] = [];
    // Every applicable constraint contributes exactly one headroom term to the
    // arithmetic mean: its determinate headroom, or ZERO_QUOTA_HEADROOM when it
    // carries none (unknown/missing/rejected/positive balance).
    const headroomPool: number[] = [];
    for (const constraint of list) {
      const assessment = this.assessConstraint(nowMs, constraint);
      assessments.push(assessment);
      switch (assessment.state) {
        case "blocked":
          hasBlocked = true;
          blockedConstraintIds.push(assessment.id);
          break;
        case "strained":
          hasStrained = true;
          headroomPool.push(assessment.headroom === null ? ZERO_QUOTA_HEADROOM : assessment.headroom);
          break;
        case "healthy":
          headroomPool.push(assessment.headroom === null ? ZERO_QUOTA_HEADROOM : assessment.headroom);
          break;
        case "unknown":
          hasUnknown = true;
          headroomPool.push(ZERO_QUOTA_HEADROOM);
          break;
        case "missing":
        case "rejected":
          hasMissingOrRejected = true;
          headroomPool.push(ZERO_QUOTA_HEADROOM);
          break;
      }
    }
    const empty = list.length === 0;
    const coverageComplete = !empty && !hasMissingOrRejected;
    let state: QuotaState;
    if (hasBlocked) {
      state = "blocked";
    }
    else if (hasStrained) {
      state = "strained";
    }
    else if (hasUnknown || hasMissingOrRejected || empty) {
      // Any unknown evidence, any missing/rejected required quota, or an empty
      // required-quota list keeps the aggregate unknown and never healthy.
      state = "unknown";
    }
    else {
      state = "healthy";
    }
    const headroomTrusted = coverageComplete && !hasUnknown && !hasBlocked && state !== "unknown";
    let headroom: number | null;
    if (state === "blocked") {
      headroom = null;
    }
    else if (empty) {
      // No applicable constraint carries no trusted headroom, not full quota.
      headroom = ZERO_QUOTA_HEADROOM;
    }
    else {
      // Equal arithmetic mean over every applicable constraint.
      let sum = 0;
      for (const term of headroomPool)
        sum += term;
      headroom = sum / headroomPool.length;
    }
    return {
      state,
      blockedConstraintIds,
      coverageComplete,
      headroomTrusted,
      headroom,
      constraints: assessments,
    };
  }
}
