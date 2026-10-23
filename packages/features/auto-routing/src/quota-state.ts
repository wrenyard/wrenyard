import {
  type BalanceEvidence,
  type ConstraintAssessment,
  type ConstraintRejectCode,
  type ConstraintState,
  type QuotaAssessment,
  type QuotaEvidence,
  type QuotaEvidenceStatus,
  type QuotaState,
  type RequiredQuotaConstraint,
} from './types.ts';
import { isFiniteNumber } from './numeric.ts';
import {
  BALANCE_LOW_THRESHOLDS,
  FULL_CYCLE_HEADROOM_WEIGHT,
  FULL_CYCLE_RESET_WEIGHT,
  QUOTA_EVIDENCE_GRACE_MS,
  QUOTA_INSUFFICIENT_REMAINING,
  ROLLING_ABUNDANT_REMAINING,
  ZERO_QUOTA_HEADROOM,
} from './constants.ts';

/**
 * The single source of truth for quota state: four levels mapped from the
 * required constraints and how their evidence was obtained.
 */
export interface QuotaStateResult {
  state: QuotaState;
  evidence: QuotaEvidenceStatus;
  /** Newest observation time behind the answer; null when nothing was observed. */
  measuredAt: number | null;
}

/** Ranking severity of each state; the worst state on a route wins. */
export const STATE_SEVERITY: Readonly<Record<QuotaState, number>> = {
  abundant: 0,
  sufficient: 1,
  insufficient: 2,
  exhausted: 3,
};

function worstState(states: readonly QuotaState[]): QuotaState {
  let worst: QuotaState = 'abundant';
  for (const state of states) {
    if (STATE_SEVERITY[state] > STATE_SEVERITY[worst]) worst = state;
  }
  return worst;
}

/** One measured assessment: the state the numbers themselves justify. */
interface MeasuredAssessment {
  state: ConstraintState;
  headroom: number | null;
  rejectCode: ConstraintRejectCode | null;
}

function rejected(rejectCode: ConstraintRejectCode): MeasuredAssessment {
  // Unusable evidence is never relaxed into a usable state: it ranks as
  // insufficient, behind every route with known headroom.
  return { state: 'insufficient', headroom: null, rejectCode };
}

function balanceThreshold(currency: string | null | undefined): number | null {
  if (typeof currency !== 'string') return null;
  for (const [code, threshold] of Object.entries(BALANCE_LOW_THRESHOLDS)) {
    if (code === currency) return threshold;
  }
  return null;
}

function measuredBalance(
  nowMs: number,
  balance: BalanceEvidence | null | undefined,
): MeasuredAssessment {
  if (balance === null || balance === undefined || typeof balance !== 'object') {
    return { state: 'insufficient', headroom: null, rejectCode: null };
  }
  if (!isFiniteNumber(nowMs)) return rejected('invalid_now');
  const observedAtMs = balance.observedAtMs;
  if (!isFiniteNumber(observedAtMs)) return rejected('observation_time_not_finite');
  if (observedAtMs > nowMs) return rejected('future_observation');
  // An explicit parser-attested availability (ChatGPT Credits) is
  // authoritative: 'available' is sufficient while fresh regardless of the
  // display-only amount; 'unavailable' is a confirmed exhaustion never
  // relaxed by age, even beside a positive amount; 'unknown' is insufficient
  // and never falls through to the amount/unlimited branches below.
  if (balance.availability !== undefined) {
    if (balance.availability === 'unavailable') {
      return { state: 'exhausted', headroom: 0, rejectCode: null };
    }
    if (balance.availability === 'unknown') {
      return { state: 'insufficient', headroom: null, rejectCode: null };
    }
    const flagValidForMs = balance.validForMs;
    if (!isFiniteNumber(flagValidForMs) || flagValidForMs <= 0) return rejected('invalid_freshness_window');
    if (nowMs - observedAtMs > flagValidForMs) return rejected('stale_observation');
    return { state: 'sufficient', headroom: null, rejectCode: null };
  }
  // An explicit provider-declared unlimited balance is usable while fresh; it
  // is never abundant and never fabricated as a large number.
  if (balance.unlimited === true) {
    const unlimitedValidForMs = balance.validForMs;
    if (!isFiniteNumber(unlimitedValidForMs) || unlimitedValidForMs <= 0) return rejected('invalid_freshness_window');
    if (nowMs - observedAtMs > unlimitedValidForMs) return rejected('stale_observation');
    return { state: 'sufficient', headroom: null, rejectCode: null };
  }
  const amount = balance.amount;
  if (typeof amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(amount)) {
    // A reported-but-absent amount is unknown, never fabricated as zero.
    if (amount === undefined) {
      return { state: 'insufficient', headroom: null, rejectCode: null };
    }
    return rejected('invalid_balance_amount');
  }
  const value = Number(amount);
  // A strictly observed zero balance is exhausted before any freshness rule:
  // staleness only ever relaxes a non-exhausted observation.
  if (value <= 0) return { state: 'exhausted', headroom: 0, rejectCode: null };
  const validForMs = balance.validForMs;
  if (!isFiniteNumber(validForMs) || validForMs <= 0) return rejected('invalid_freshness_window');
  if (nowMs - observedAtMs > validForMs) return rejected('stale_observation');
  // A pay-as-you-go balance is never abundant: at or below its currency's low
  // threshold it is insufficient, and an unknown currency has no threshold.
  const threshold = balanceThreshold(balance.currency);
  if (threshold !== null && value <= threshold) {
    return { state: 'insufficient', headroom: null, rejectCode: null };
  }
  return { state: 'sufficient', headroom: null, rejectCode: null };
}

function rollingBands(remainingRatio: number): MeasuredAssessment {
  if (remainingRatio >= ROLLING_ABUNDANT_REMAINING) {
    return {
      state: 'abundant',
      headroom: FULL_CYCLE_HEADROOM_WEIGHT * remainingRatio,
      rejectCode: null,
    };
  }
  if (remainingRatio <= QUOTA_INSUFFICIENT_REMAINING) {
    return {
      state: 'insufficient',
      headroom: FULL_CYCLE_HEADROOM_WEIGHT * remainingRatio,
      rejectCode: null,
    };
  }
  // The middle band carries no determinate headroom.
  return { state: 'sufficient', headroom: null, rejectCode: null };
}

function measuredWindow(nowMs: number, evidence: QuotaEvidence | null | undefined): MeasuredAssessment {
  if (evidence === null || evidence === undefined || typeof evidence !== 'object') {
    return { state: 'insufficient', headroom: null, rejectCode: null };
  }
  if (!isFiniteNumber(nowMs)) return rejected('invalid_now');
  const remainingPercent = evidence.remainingPercent;
  if (!isFiniteNumber(remainingPercent)) return rejected('remaining_percent_not_finite');
  if (remainingPercent < 0 || remainingPercent > 100) return rejected('remaining_percent_out_of_range');
  const remainingRatio = remainingPercent / 100;
  // A strictly observed exhaustion is never relaxed by staleness, so a valid
  // numeric zero classifies before any freshness rule.
  if (remainingRatio === 0) return { state: 'exhausted', headroom: 0, rejectCode: null };
  const observedAtMs = evidence.observedAtMs;
  if (!isFiniteNumber(observedAtMs)) return rejected('observation_time_not_finite');
  if (observedAtMs > nowMs) return rejected('future_observation');
  const validForMs = evidence.validForMs;
  if (!isFiniteNumber(validForMs) || validForMs <= 0) return rejected('invalid_freshness_window');
  if (nowMs - observedAtMs > validForMs) return rejected('stale_observation');
  const replenishmentKind = evidence.replenishmentKind;
  if (replenishmentKind !== 'full_cycle' &&
    replenishmentKind !== 'rolling_partial' &&
    replenishmentKind !== 'unknown') {
    return rejected('invalid_replenishment_kind');
  }
  if (replenishmentKind === 'full_cycle') {
    const resetAtMs = evidence.resetAtMs;
    const windowMs = evidence.windowMs;
    if (!isFiniteNumber(resetAtMs) || resetAtMs <= nowMs) return rejected('invalid_reset_time');
    if (!isFiniteNumber(windowMs) || windowMs <= 0) return rejected('invalid_cycle_duration');
    const resetHorizonMs = resetAtMs - nowMs;
    if (resetHorizonMs <= 0 || resetHorizonMs > windowMs) return rejected('reset_horizon_beyond_duration');
    const expectedRemaining = resetHorizonMs / windowMs;
    // Ten percentage points saved against the cycle pace earns full credit.
    const paceTerm = Math.min(1, Math.max(0, (remainingRatio - expectedRemaining) / 0.1));
    const headroom = FULL_CYCLE_HEADROOM_WEIGHT * remainingRatio +
      FULL_CYCLE_RESET_WEIGHT * paceTerm;
    // A window at or below the insufficient bound is insufficient only when it
    // also trails its cycle pace; under pace close to a reset it is sufficient.
    let state: ConstraintState;
    if (remainingRatio >= expectedRemaining) state = 'abundant';
    else if (remainingRatio <= QUOTA_INSUFFICIENT_REMAINING) state = 'insufficient';
    else state = 'sufficient';
    return { state, headroom, rejectCode: null };
  }
  // rolling_partial and unknown carry no reset facts, so no pace is defined.
  return rollingBands(remainingRatio);
}

function measuredAssessment(nowMs: number, constraint: RequiredQuotaConstraint): MeasuredAssessment {
  if (constraint === null || typeof constraint !== 'object') {
    return { state: 'insufficient', headroom: null, rejectCode: null };
  }
  const balance = constraint.balance;
  if (constraint.kind === 'balance' || balance != null) {
    return measuredBalance(nowMs, balance);
  }
  return measuredWindow(nowMs, constraint.evidence);
}

function evidenceStatusOf(constraint: RequiredQuotaConstraint): QuotaEvidenceStatus {
  if (constraint.usageUnknown === true) return 'unknown_by_design';
  if (constraint.evidenceStatus !== undefined) return constraint.evidenceStatus;
  return constraint.evidence != null || constraint.balance != null ? 'measured' : 'not_obtained';
}

function assessConstraint(nowMs: number, constraint: RequiredQuotaConstraint): ConstraintAssessment {
  if (constraint === null || typeof constraint !== 'object') {
    return { id: '', state: 'insufficient', evidenceStatus: 'not_obtained', headroom: null, rejectCode: null };
  }
  const id = typeof constraint.id === 'string' ? constraint.id : '';
  const evidenceStatus = evidenceStatusOf(constraint);
  if (constraint.observedExhausted === true) {
    return { id, state: 'exhausted', evidenceStatus, headroom: 0, rejectCode: null };
  }
  const measured = measuredAssessment(nowMs, constraint);
  // Usage unknown by design is usable but never abundant: only a strictly
  // observed exhaustion is honored, and it is never relaxed.
  if (evidenceStatus === 'unknown_by_design') {
    if (measured.state === 'exhausted') {
      return { id, state: 'exhausted', evidenceStatus, headroom: 0, rejectCode: null };
    }
    return { id, state: 'insufficient', evidenceStatus, headroom: null, rejectCode: null };
  }
  return { id, state: measured.state, evidenceStatus, headroom: measured.headroom, rejectCode: measured.rejectCode };
}

function observedAtOf(constraint: RequiredQuotaConstraint): number | null {
  if (constraint === null || typeof constraint !== 'object') return null;
  const balance = constraint.balance;
  const observedAtMs = balance != null && typeof balance === 'object'
    ? balance.observedAtMs
    : constraint.evidence?.observedAtMs;
  return isFiniteNumber(observedAtMs) ? observedAtMs : null;
}

/** Full aggregate assessment: state, evidence status, headroom and per-constraint detail. */
export function assessRequiredQuota(
  nowMs: number,
  constraints: readonly RequiredQuotaConstraint[],
  opts?: { confirmedFreeSupply?: boolean },
): QuotaAssessment {
  const list = Array.isArray(constraints) ? constraints : [];
  // Confirmed free supply with nothing measured, including a route with no
  // required constraint at all, is a free allowance: it is abundant.
  const confirmedFreeSupply = opts?.confirmedFreeSupply === true;
  if (list.length === 0) {
    // No required resource is scarce and none was measured.
    return {
      state: confirmedFreeSupply ? 'abundant' : 'sufficient',
      evidence: 'measured',
      measuredAt: null,
      exhaustedConstraintIds: [],
      coverageComplete: false,
      headroom: ZERO_QUOTA_HEADROOM,
      constraints: [],
    };
  }
  const assessments = list.map((constraint) => assessConstraint(nowMs, constraint));
  let evidence: QuotaEvidenceStatus = 'measured';
  if (assessments.some((assessment) => assessment.evidenceStatus === 'not_obtained')) {
    evidence = 'not_obtained';
  }
  else if (assessments.some((assessment) => assessment.evidenceStatus === 'unknown_by_design')) {
    evidence = 'unknown_by_design';
  }
  let measuredAt: number | null = null;
  for (const constraint of list) {
    const observedAtMs = observedAtOf(constraint);
    if (observedAtMs !== null && observedAtMs <= nowMs && (measuredAt === null || observedAtMs > measuredAt)) {
      measuredAt = observedAtMs;
    }
  }
  const measuredStates = assessments.map((assessment) => assessment.state);
  // A recorded exhaustion is never relaxed, not even by an expired grace period.
  let state: QuotaState;
  if (evidence === 'not_obtained' && !measuredStates.includes('exhausted')) {
    state = measuredAt !== null && nowMs - measuredAt <= QUOTA_EVIDENCE_GRACE_MS
      ? worstState(measuredStates)
      : 'insufficient';
  }
  else {
    state = worstState(measuredStates);
  }
  // A confirmed free allowance with no measured evidence at all is abundant;
  // exhaustion is never promoted, and measured evidence keeps governing.
  if (confirmedFreeSupply && state !== 'exhausted'
    && !list.some((constraint) => constraint != null && typeof constraint === 'object'
      && (constraint.evidence != null || constraint.balance != null))) {
    state = 'abundant';
  }
  const exhaustedConstraintIds = assessments
    .filter((assessment) => assessment.state === 'exhausted')
    .map((assessment) => assessment.id);
  const coverageComplete = assessments.every((assessment) =>
    assessment.rejectCode === null && assessment.evidenceStatus === 'measured');
  let headroom: number | null;
  if (state === 'exhausted') {
    headroom = null;
  }
  else {
    let sum = 0;
    for (const assessment of assessments) sum += assessment.headroom ?? ZERO_QUOTA_HEADROOM;
    headroom = sum / assessments.length;
  }
  return {
    state,
    evidence,
    measuredAt,
    exhaustedConstraintIds,
    coverageComplete,
    headroom,
    constraints: assessments,
  };
}

/**
 * Maps the required quota constraints of one route to its single quota state.
 *
 * `not_obtained` routes keep the last measured state for a grace period from
 * that measurement and become insufficient afterwards; a recorded exhaustion is
 * never relaxed. `unknown_by_design` routes are insufficient unless exhaustion
 * was strictly observed.
 */
export function quotaStateOf(
  constraints: readonly RequiredQuotaConstraint[],
  nowMs: number,
  opts?: { confirmedFreeSupply?: boolean },
): QuotaStateResult {
  const assessment = assessRequiredQuota(nowMs, constraints, opts);
  return {
    state: assessment.state,
    evidence: assessment.evidence,
    measuredAt: assessment.measuredAt,
  };
}
