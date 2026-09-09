/**
 * Pure, deterministic, quota-aware conservative auto-routing policy.
 *
 * This module is fully self-contained and side-effect free:
 *   - no IO, no timezone handling, no retries, no fallback routing;
 *   - every decision is a pure function of the caller-supplied inputs;
 *   - numeric handling is defensive: NaN / Infinity / negative or
 *     out-of-range values are rejected, never clamped into a healthy state;
 *   - inputs are defensively snapshotted so later caller mutation cannot
 *     change returned results.
 */

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

/**
 * Final score weights. P + S together form one unified economic allocation:
 * (P + S) weights the marginal speed/price exchange term of the score, while Q
 * weights quota headroom quality and I weights intelligence. Individual values
 * are kept unchanged for compatibility with prior releases.
 */
export const SCORE_WEIGHTS = { P: 0.55, Q: 0.3, S: 0.1, I: 0.05 } as const;

/**
 * Marginal exchange rate embedded in the score: +1 TPS of effective speed is
 * worth USD 0.01 per M output tokens (and +100 TPS is worth USD 1 per M).
 */
export const SPEED_PRICE_TRADEOFF_USD_PER_M_PER_TPS = 0.01;

/**
 * @deprecated Kept exported only as a compatibility constant from the
 * superseded cheapest-set admission gate. Same-tier ranking no longer uses a
 * cheapest-set prefilter or any HEADROOM_CHALLENGE_MIN_GAP challenge rule;
 * every candidate is ranked by one deterministic descending score instead.
 */
export const HEADROOM_CHALLENGE_MIN_GAP = 0.5;

/** Neutral headroom used whenever evidence is genuinely unknown. */
export const NEUTRAL_HEADROOM = 0.5;

/** Reference prices at or above this threshold reject while the tier is unknown or coverage is incomplete. */
export const REFERENCE_PRICE_GATE_USD_PER_M = 10;

/** Full-cycle replenishment assessment constants. */
export const FULL_CYCLE_MIN_REMAINING = 0.05;
export const FULL_CYCLE_RESET_PACE = 0.8;
export const FULL_CYCLE_HEADROOM_WEIGHT = 0.75;
export const FULL_CYCLE_RESET_WEIGHT = 0.25;

/** Rolling-partial replenishment bands. */
export const HEALTHY_ROLLING_REMAINING = 0.8;
export const STRAINED_ROLLING_REMAINING = 0.05;

/** Verified quota-burn efficiency blend. Applies to Q only, never to H/tier/eligibility. */
export const EFFICIENCY_HEADROOM_WEIGHT = 0.85;
export const EFFICIENCY_EVIDENCE_WEIGHT = 0.15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReferenceKind = "listed" | "verified_free";
export type ReplenishmentKind = "full_cycle" | "rolling_partial" | "unknown";
export type QuotaTier = "healthy" | "unknown" | "strained";
export type QuotaState = QuotaTier | "blocked";
export type SupplyClass = "confirmed_free" | "standard";

/** Evidence for one required quota constraint observed at a point in time. */
export interface QuotaEvidence {
  /** Finite remaining quota as a percent of the limit, in [0, 100]. */
  remainingPercent: number;
  /** Timestamp (epoch ms) the observation was taken. */
  observedAtMs: number;
  /** How long after observedAtMs the observation is considered fresh. */
  validForMs: number;
  replenishmentKind: ReplenishmentKind;
  /** Required when replenishmentKind === "full_cycle": future reset time (epoch ms). */
  resetAtMs?: number;
  /** Required when replenishmentKind === "full_cycle": reset-cycle duration (ms). */
  windowMs?: number;
}

/** One required quota constraint; null evidence means the constraint is uncovered. */
export interface RequiredQuotaConstraint {
  id: string;
  evidence: QuotaEvidence | null;
}

/** Canonical conservative marker required on every routed evidence object. */
export type WorstApplicableMarker = "worst_applicable";

/** Domain accepted for verified quota-burn efficiency evidence. */
export type QuotaBurnEfficiencyDomain = "quota_burn_efficiency";

/**
 * Optional worst-applicable marginal price (USD per M output tokens) carrying
 * verification provenance. The marginal value is only used for
 * routingPrice/score while source/ruleId are nonempty, the conservative
 * worst_applicable marker is present, and the UTC applicability interval
 * fully covers [now, now + timeoutMs]. A valid applicable monetary value
 * above the listed reference rejects the candidate instead of routing higher.
 */
export interface MarginalPriceEvidence {
  usdPerM: number;
  appliesFromMs: number;
  appliesUntilMs: number;
  /** Provenance: evidence source identifier. */
  source: string;
  /** Provenance: rule identifier that produced the evidence. */
  ruleId: string;
  /** Conservative literal: only worst-applicable evidence is accepted. */
  worst_applicable: WorstApplicableMarker;
}

/**
 * Verified quota-burn efficiency evidence, time-scoped and provenance-bearing.
 * A raw numeric efficiency (e.g. an unverifiable credit reward) is never
 * accepted as evidence: the score only blends into Q while every field is
 * valid/nonempty and the interval covers [now, now + timeoutMs].
 */
export interface QuotaBurnEfficiencyEvidence {
  /** Normalized verified quota-burn efficiency in [0, 1]. */
  efficiencyScore: number;
  appliesFromMs: number;
  appliesUntilMs: number;
  source: string;
  ruleId: string;
  domain: QuotaBurnEfficiencyDomain;
  /** Conservative literal: only worst-applicable evidence is accepted. */
  worst_applicable: WorstApplicableMarker;
}

/**
 * Provider-verified free-supply fact for the exact account/environment snapshot.
 * It is independent from reference pricing and only affects outer ordering
 * after every hard gate has passed.
 */
export interface ConfirmedFreeSupplyEvidence {
  kind: "confirmed_free";
  appliesFromMs: number;
  appliesUntilMs: number;
  source: string;
  ruleId: string;
}

/** Caller-supplied inputs for one candidate snapshot. */
export interface CandidateInput {
  snapshotId: string;
  canonicalId: string;
  nowMs: number;
  /** Listed (or verified_free) reference output price, USD per M tokens. */
  referenceUsdPerM: number;
  referenceKind: ReferenceKind;
  /** Effective reference cap in the same USD/M units. */
  effectiveCapUsdPerM: number;
  /** Routing horizon that the marginal interval must fully cover. */
  timeoutMs: number;
  minimumTps: number;
  expectedTps: number;
  effectiveTps: number;
  intelligenceRank: number;
  intelligenceMinRank: number;
  intelligenceMaxRank: number;
  /** Required quota constraints; missing/invalid evidence leaves coverage incomplete. */
  requiredQuota: readonly RequiredQuotaConstraint[];
  marginalPrice?: MarginalPriceEvidence | null;
  /**
   * Optional verified quota-burn efficiency evidence. A bare numeric credit is
   * never accepted; the Q blend applies only while every field is valid/
   * nonempty and the interval covers [now, now + timeoutMs].
   */
  verifiedEfficiency?: QuotaBurnEfficiencyEvidence | null;
  confirmedFreeSupply?: ConfirmedFreeSupplyEvidence | null;
}

export type ConstraintState =
  | "blocked"
  | "strained"
  | "unknown"
  | "healthy"
  | "missing"
  | "rejected";

export type ConstraintRejectCode =
  | "invalid_now"
  | "remaining_percent_not_finite"
  | "remaining_percent_out_of_range"
  | "observation_time_not_finite"
  | "future_observation"
  | "invalid_freshness_window"
  | "stale_observation"
  | "invalid_replenishment_kind"
  | "invalid_reset_time"
  | "invalid_cycle_duration"
  | "reset_horizon_beyond_duration";

export interface ConstraintAssessment {
  id: string;
  state: ConstraintState;
  /** Headroom in [0, 1]; null when the state carries no determinate headroom. */
  headroom: number | null;
  /** Machine-readable reason when state === "rejected". */
  rejectCode: ConstraintRejectCode | null;
}

/** Aggregate quota assessment across all required constraints. */
export interface QuotaAssessment {
  state: QuotaState;
  blockedConstraintIds: string[];
  coverageComplete: boolean;
  headroomTrusted: boolean;
  headroom: number | null;
  constraints: ConstraintAssessment[];
}

export type ExcludedReason =
  | "invalid_candidate"
  | "invalid_now"
  | "invalid_timeout"
  | "invalid_reference_kind"
  | "invalid_reference_price"
  | "listed_reference_zero"
  | "invalid_cap"
  | "reference_above_cap"
  | "invalid_speed"
  | "speed_below_minimum"
  | "invalid_intelligence"
  | "intelligence_out_of_range"
  | "quota_blocked"
  | "reference_price_gate"
  | "marginal_above_reference"
  | "snapshot_context_mismatch";

export interface ExcludedCandidate {
  snapshotId: string;
  canonicalId: string;
  reason: ExcludedReason;
  detail: string | null;
}

/** Evaluated metrics for an accepted candidate. */
export interface CandidateAssessment {
  snapshotId: string;
  canonicalId: string;
  tier: QuotaTier;
  referenceUsdPerM: number;
  routingPriceUsdPerM: number;
  marginalApplied: boolean;
  supplyClass: SupplyClass;
  confirmedFreeSupplyApplied: boolean;
  confirmedFreeSupplyEvidence: { source: string; ruleId: string } | null;
  /** Raw headroom H feeding the quota headroom factor Q. */
  headroom: number;
  /** Quota headroom factor Q used in the score (may blend verified efficiency). */
  quotaQuality: number;
  /** Diagnostic price factor; kept as a public field but no longer ranked. */
  priceFactor: number;
  /** Diagnostic expected-saturated speed factor; kept as a public field but no longer ranked. */
  speedFactor: number;
  /** Intelligence factor I used in the score. */
  intelligenceFactor: number;
  /**
   * Unified ranking score (see SCORE_WEIGHTS/SPEED_PRICE_TRADEOFF_USD_PER_M_PER_TPS).
   * A ranking utility, not a price or a bill, so it may be negative.
   */
  score: number;
  verifiedEfficiency: number | null;
  coverageComplete: boolean;
  headroomTrusted: boolean;
  quota: QuotaAssessment;
  notes: string[];
}

export type CandidateEvaluation =
  | { kind: "accepted"; assessment: CandidateAssessment }
  | {
      kind: "rejected";
      snapshotId: string;
      canonicalId: string;
      reason: ExcludedReason;
      detail: string | null;
    };

/** One position in the final ranked output. */
export interface RankedCandidate {
  rank: number;
  snapshotId: string;
  canonicalId: string;
  tier: QuotaTier;
  score: number;
  referenceUsdPerM: number;
  routingPriceUsdPerM: number;
  marginalApplied: boolean;
  supplyClass: SupplyClass;
  confirmedFreeSupplyApplied: boolean;
  confirmedFreeSupplyEvidence: { source: string; ruleId: string } | null;
  headroom: number;
  quotaQuality: number;
  priceFactor: number;
  speedFactor: number;
  intelligenceFactor: number;
  verifiedEfficiency: number | null;
  coverageComplete: boolean;
  headroomTrusted: boolean;
  quota: QuotaAssessment;
  notes: string[];
}

export interface AutoRoutingResult {
  ranked: RankedCandidate[];
  excluded: ExcludedCandidate[];
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function minOf(values: number[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const v of values) {
    if (v < best) best = v;
  }
  return best;
}

function compareLex(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Quota assessment
// ---------------------------------------------------------------------------

function assessConstraint(
  nowMs: number,
  constraint: RequiredQuotaConstraint
): ConstraintAssessment {
  if (constraint === null || typeof constraint !== "object") {
    return { id: "", state: "missing", headroom: null, rejectCode: null };
  }
  const id = typeof constraint.id === "string" ? constraint.id : "";
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
  if (
    replenishmentKind !== "full_cycle" &&
    replenishmentKind !== "rolling_partial" &&
    replenishmentKind !== "unknown"
  ) {
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
    const healthyThreshold = Math.max(
      FULL_CYCLE_MIN_REMAINING,
      FULL_CYCLE_RESET_PACE * expectedRemaining
    );
    const paceTerm = Math.min(
      1,
      remainingRatio / Math.max(expectedRemaining, FULL_CYCLE_MIN_REMAINING)
    );
    const headroom =
      FULL_CYCLE_HEADROOM_WEIGHT * remainingRatio +
      FULL_CYCLE_RESET_WEIGHT * paceTerm;
    const state: ConstraintState =
      remainingRatio >= healthyThreshold ? "healthy" : "strained";
    return { id, state, headroom, rejectCode: null };
  }

  if (replenishmentKind === "rolling_partial") {
    if (remainingRatio >= HEALTHY_ROLLING_REMAINING) {
      return { id, state: "healthy", headroom: remainingRatio, rejectCode: null };
    }
    if (remainingRatio > 0 && remainingRatio < STRAINED_ROLLING_REMAINING) {
      return { id, state: "strained", headroom: remainingRatio, rejectCode: null };
    }
    // Middle band [0.05, 0.80): genuinely unknown headroom, neutral H = 0.5.
    return { id, state: "unknown", headroom: null, rejectCode: null };
  }

  // Unknown replenishment kind stays unknown.
  return { id, state: "unknown", headroom: null, rejectCode: null };
}

/**
 * Aggregate the required quota constraints monotonically:
 * blocked first, then any strained (coverage may still be incomplete),
 * then unknown, and only complete, trustworthy, healthy evidence is healthy.
 */
export function assessRequiredQuota(
  nowMs: number,
  constraints: readonly RequiredQuotaConstraint[]
): QuotaAssessment {
  // An empty (or non-array) constraint list is not covered quota evidence.
  const list = Array.isArray(constraints) ? constraints : [];
  const assessments: ConstraintAssessment[] = [];
  let hasBlocked = false;
  let hasStrained = false;
  let hasUnknown = false;
  let hasMissingOrRejected = false;
  const blockedConstraintIds: string[] = [];
  const headroomPool: number[] = [];

  for (const constraint of list) {
    const assessment = assessConstraint(nowMs, constraint);
    assessments.push(assessment);
    switch (assessment.state) {
      case "blocked":
        hasBlocked = true;
        blockedConstraintIds.push(assessment.id);
        break;
      case "strained":
        hasStrained = true;
        if (assessment.headroom !== null) headroomPool.push(assessment.headroom);
        break;
      case "healthy":
        if (assessment.headroom !== null) headroomPool.push(assessment.headroom);
        break;
      case "unknown":
        hasUnknown = true;
        break;
      case "missing":
      case "rejected":
        hasMissingOrRejected = true;
        break;
    }
  }

  const empty = list.length === 0;
  const coverageComplete = !empty && !hasMissingOrRejected;

  let state: QuotaState;
  if (hasBlocked) {
    state = "blocked";
  } else if (hasStrained) {
    state = "strained";
  } else if (hasUnknown || hasMissingOrRejected || empty) {
    // Any unknown evidence, any missing/rejected required quota, or an empty
    // required-quota list keeps the aggregate unknown and never healthy.
    state = "unknown";
  } else {
    state = "healthy";
  }

  const headroomTrusted =
    coverageComplete && !hasUnknown && !hasBlocked && state !== "unknown";

  let headroom: number | null;
  if (state === "blocked") {
    headroom = null;
  } else if (state === "unknown") {
    headroom = NEUTRAL_HEADROOM;
  } else if (headroomPool.length === 0) {
    headroom = state === "healthy" ? 1 : NEUTRAL_HEADROOM;
  } else {
    headroom = minOf(headroomPool);
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

// ---------------------------------------------------------------------------
// Candidate evaluation
// ---------------------------------------------------------------------------

/** Deep-copy caller input so later mutation of the caller's objects has no effect. */
function snapshotCandidate(input: CandidateInput): CandidateInput {
  const requiredQuota: RequiredQuotaConstraint[] = Array.isArray(input.requiredQuota)
    ? input.requiredQuota.map((constraint) => {
        if (constraint === null || typeof constraint !== "object") {
          return { id: "", evidence: null };
        }
        const id = typeof constraint.id === "string" ? constraint.id : "";
        const evidence = constraint.evidence;
        if (evidence === null || evidence === undefined || typeof evidence !== "object") {
          return { id, evidence: null };
        }
        const snapshotEvidence: QuotaEvidence = {
          remainingPercent: evidence.remainingPercent,
          observedAtMs: evidence.observedAtMs,
          validForMs: evidence.validForMs,
          replenishmentKind: evidence.replenishmentKind,
        };
        if (evidence.resetAtMs !== undefined) {
          snapshotEvidence.resetAtMs = evidence.resetAtMs;
        }
        if (evidence.windowMs !== undefined) {
          snapshotEvidence.windowMs = evidence.windowMs;
        }
        return { id, evidence: snapshotEvidence };
      })
    : [];

  let marginalPrice: MarginalPriceEvidence | null = null;
  const marginal = input.marginalPrice ?? null;
  if (marginal !== null && typeof marginal === "object") {
    marginalPrice = {
      usdPerM: marginal.usdPerM,
      appliesFromMs: marginal.appliesFromMs,
      appliesUntilMs: marginal.appliesUntilMs,
      source: marginal.source,
      ruleId: marginal.ruleId,
      worst_applicable: marginal.worst_applicable,
    };
  }

  // A raw numeric efficiency ("credit") is not evidence: only an object is
  // snapshotted, so a bare number can never drive the Q blend.
  let verifiedEfficiency: QuotaBurnEfficiencyEvidence | null = null;
  const efficiency = input.verifiedEfficiency ?? null;
  if (efficiency !== null && typeof efficiency === "object") {
    verifiedEfficiency = {
      efficiencyScore: efficiency.efficiencyScore,
      appliesFromMs: efficiency.appliesFromMs,
      appliesUntilMs: efficiency.appliesUntilMs,
      source: efficiency.source,
      ruleId: efficiency.ruleId,
      domain: efficiency.domain,
      worst_applicable: efficiency.worst_applicable,
    };
  }

  let confirmedFreeSupply: ConfirmedFreeSupplyEvidence | null = null;
  const freeSupply = input.confirmedFreeSupply ?? null;
  if (freeSupply !== null && typeof freeSupply === "object") {
    confirmedFreeSupply = {
      kind: freeSupply.kind,
      appliesFromMs: freeSupply.appliesFromMs,
      appliesUntilMs: freeSupply.appliesUntilMs,
      source: freeSupply.source,
      ruleId: freeSupply.ruleId,
    };
  }

  const snapshot: CandidateInput = {
    snapshotId: input.snapshotId,
    canonicalId: input.canonicalId,
    nowMs: input.nowMs,
    referenceUsdPerM: input.referenceUsdPerM,
    referenceKind: input.referenceKind,
    effectiveCapUsdPerM: input.effectiveCapUsdPerM,
    timeoutMs: input.timeoutMs,
    minimumTps: input.minimumTps,
    expectedTps: input.expectedTps,
    effectiveTps: input.effectiveTps,
    intelligenceRank: input.intelligenceRank,
    intelligenceMinRank: input.intelligenceMinRank,
    intelligenceMaxRank: input.intelligenceMaxRank,
    requiredQuota,
    marginalPrice,
    verifiedEfficiency,
    confirmedFreeSupply,
  };
  return snapshot;
}

function rejected(
  snapshotId: string,
  canonicalId: string,
  reason: ExcludedReason,
  detail: string | null
): CandidateEvaluation {
  return { kind: "rejected", snapshotId, canonicalId, reason, detail };
}

/**
 * Validate one candidate against the hard guards and compute its tier/metrics.
 * Pure: returns a fresh evaluation object and never mutates its input.
 */
export function evaluateCandidate(input: CandidateInput): CandidateEvaluation {
  if (input === null || typeof input !== "object") {
    return rejected("", "", "invalid_candidate", "input is not an object");
  }
  const candidate = snapshotCandidate(input);
  const snapshotId = candidate.snapshotId;
  const canonicalId = candidate.canonicalId;

  if (typeof snapshotId !== "string" || snapshotId.length === 0) {
    return rejected(
      snapshotId,
      canonicalId,
      "invalid_candidate",
      "snapshotId must be a nonempty string"
    );
  }
  if (typeof canonicalId !== "string" || canonicalId.length === 0) {
    return rejected(
      snapshotId,
      canonicalId,
      "invalid_candidate",
      "canonicalId must be a nonempty string"
    );
  }

  if (!isFiniteNumber(candidate.nowMs)) {
    return rejected(snapshotId, canonicalId, "invalid_now", "nowMs must be finite");
  }
  if (!isFiniteNumber(candidate.timeoutMs) || candidate.timeoutMs <= 0) {
    return rejected(snapshotId, canonicalId, "invalid_timeout", "timeoutMs must be a finite positive duration");
  }
  if (candidate.referenceKind !== "listed" && candidate.referenceKind !== "verified_free") {
    return rejected(snapshotId, canonicalId, "invalid_reference_kind", "referenceKind must be listed or verified_free");
  }
  if (!isFiniteNumber(candidate.referenceUsdPerM) || candidate.referenceUsdPerM < 0) {
    return rejected(snapshotId, canonicalId, "invalid_reference_price", "reference price must be finite and non-negative");
  }
  if (candidate.referenceKind === "listed" && candidate.referenceUsdPerM === 0) {
    return rejected(snapshotId, canonicalId, "listed_reference_zero", "zero reference price is only allowed when verified_free");
  }
  if (!isFiniteNumber(candidate.effectiveCapUsdPerM) || candidate.effectiveCapUsdPerM < 0) {
    return rejected(snapshotId, canonicalId, "invalid_cap", "effective cap must be finite and non-negative");
  }
  if (candidate.referenceUsdPerM > candidate.effectiveCapUsdPerM) {
    return rejected(snapshotId, canonicalId, "reference_above_cap", "reference price exceeds the effective reference cap");
  }

  if (
    !isFiniteNumber(candidate.minimumTps) ||
    !isFiniteNumber(candidate.expectedTps) ||
    !isFiniteNumber(candidate.effectiveTps) ||
    candidate.minimumTps < 0 ||
    candidate.expectedTps < 0 ||
    candidate.effectiveTps < 0
  ) {
    return rejected(snapshotId, canonicalId, "invalid_speed", "speed numbers must be finite and non-negative");
  }
  // expectedTps below minimumTps is not a rejection: S = 1 when
  // expectedTps <= minimumTps. Only a deficient effectiveTps is rejected.
  if (candidate.effectiveTps < candidate.minimumTps) {
    return rejected(snapshotId, canonicalId, "speed_below_minimum", "effective TPS is below the minimum TPS");
  }

  if (
    !isFiniteNumber(candidate.intelligenceRank) ||
    !isFiniteNumber(candidate.intelligenceMinRank) ||
    !isFiniteNumber(candidate.intelligenceMaxRank) ||
    candidate.intelligenceMinRank > candidate.intelligenceMaxRank
  ) {
    return rejected(snapshotId, canonicalId, "invalid_intelligence", "intelligence bounds must be finite with min <= max");
  }
  if (
    candidate.intelligenceRank < candidate.intelligenceMinRank ||
    candidate.intelligenceRank > candidate.intelligenceMaxRank
  ) {
    return rejected(snapshotId, canonicalId, "intelligence_out_of_range", "intelligence rank is outside [min, max]");
  }

  const quota = assessRequiredQuota(candidate.nowMs, candidate.requiredQuota);
  if (quota.state === "blocked") {
    return rejected(
      snapshotId,
      canonicalId,
      "quota_blocked",
      `blocked constraints: ${quota.blockedConstraintIds.join(",") || "(none)"}`
    );
  }
  const tier: QuotaTier = quota.state;

  // Reference price is the hard guard: >= 10 rejects whenever the tier is
  // unknown OR trustworthy required coverage is incomplete (incl. incomplete-strained).
  if (
    candidate.referenceUsdPerM >= REFERENCE_PRICE_GATE_USD_PER_M &&
    (tier === "unknown" || !quota.coverageComplete)
  ) {
    return rejected(
      snapshotId,
      canonicalId,
      "reference_price_gate",
      `reference price >= 10 with tier=${tier}; coverageComplete=${quota.coverageComplete}`
    );
  }

  const notes: string[] = [];

  let supplyClass: SupplyClass = "standard";
  let confirmedFreeSupplyApplied = false;
  let confirmedFreeSupplyEvidence: { source: string; ruleId: string } | null = null;
  const freeSupply = candidate.confirmedFreeSupply;
  if (freeSupply !== null && freeSupply !== undefined) {
    const freeEvidenceWellFormed =
      freeSupply.kind === "confirmed_free" &&
      isFiniteNumber(freeSupply.appliesFromMs) &&
      isFiniteNumber(freeSupply.appliesUntilMs) &&
      freeSupply.appliesFromMs <= freeSupply.appliesUntilMs &&
      typeof freeSupply.source === "string" &&
      freeSupply.source.length > 0 &&
      typeof freeSupply.ruleId === "string" &&
      freeSupply.ruleId.length > 0;
    if (!freeEvidenceWellFormed) {
      notes.push("confirmed_free_supply_evidence_invalid_ignored");
    } else if (
      freeSupply.appliesFromMs > candidate.nowMs ||
      freeSupply.appliesUntilMs < candidate.nowMs + candidate.timeoutMs
    ) {
      notes.push("confirmed_free_supply_interval_does_not_cover_timeout_horizon");
    } else {
      supplyClass = "confirmed_free";
      confirmedFreeSupplyApplied = true;
      confirmedFreeSupplyEvidence = {
        source: freeSupply.source,
        ruleId: freeSupply.ruleId,
      };
      notes.push("confirmed_free_supply_applied");
    }
  }

  // Marginal price: usable only when it carries verification provenance
  // (nonempty source/ruleId), the conservative worst_applicable marker, and a
  // UTC interval covering [now, now + timeout]. Invalid/stale/insufficient
  // evidence falls back to reference; an otherwise-valid applicable marginal
  // above the listed reference rejects the candidate.
  let routingPriceUsdPerM = candidate.referenceUsdPerM;
  let marginalApplied = false;
  const marginal = candidate.marginalPrice;
  if (marginal !== null && marginal !== undefined) {
    const usdPerM = marginal.usdPerM;
    const appliesFromMs = marginal.appliesFromMs;
    const appliesUntilMs = marginal.appliesUntilMs;
    const source = marginal.source;
    const ruleId = marginal.ruleId;
    const evidenceWellFormed =
      isFiniteNumber(usdPerM) &&
      usdPerM >= 0 &&
      isFiniteNumber(appliesFromMs) &&
      isFiniteNumber(appliesUntilMs) &&
      appliesFromMs <= appliesUntilMs &&
      typeof source === "string" &&
      source.length > 0 &&
      typeof ruleId === "string" &&
      ruleId.length > 0 &&
      marginal.worst_applicable === "worst_applicable";
    if (!evidenceWellFormed) {
      notes.push("marginal_evidence_invalid_ignored");
    } else if (
      appliesFromMs > candidate.nowMs ||
      appliesUntilMs < candidate.nowMs + candidate.timeoutMs
    ) {
      notes.push("marginal_interval_does_not_cover_timeout_horizon");
    } else if (usdPerM > candidate.referenceUsdPerM) {
      return rejected(
        snapshotId,
        canonicalId,
        "marginal_above_reference",
        `marginal usdPerM=${usdPerM} exceeds the reference ${candidate.referenceUsdPerM}`
      );
    } else {
      routingPriceUsdPerM = usdPerM;
      marginalApplied = true;
      notes.push("marginal_price_applied");
    }
  }

  // Verified quota-burn efficiency adjusts Q only; it never changes H, tier,
  // or any eligibility gate. It is applied only while every field is valid and
  // nonempty and the interval covers [now, now + timeout]; with no required
  // quota constraint there is no quota to blend against, so Q stays neutral.
  // A bare numeric credit is never accepted as evidence.
  let verifiedEfficiency: number | null = null;
  const efficiencyEvidence = candidate.verifiedEfficiency;
  if (
    efficiencyEvidence !== null &&
    efficiencyEvidence !== undefined &&
    typeof efficiencyEvidence === "object"
  ) {
    const efficiencyScore = efficiencyEvidence.efficiencyScore;
    const appliesFromMs = efficiencyEvidence.appliesFromMs;
    const appliesUntilMs = efficiencyEvidence.appliesUntilMs;
    const source = efficiencyEvidence.source;
    const ruleId = efficiencyEvidence.ruleId;
    const evidenceWellFormed =
      isFiniteNumber(efficiencyScore) &&
      efficiencyScore >= 0 &&
      efficiencyScore <= 1 &&
      isFiniteNumber(appliesFromMs) &&
      isFiniteNumber(appliesUntilMs) &&
      appliesFromMs <= appliesUntilMs &&
      typeof source === "string" &&
      source.length > 0 &&
      typeof ruleId === "string" &&
      ruleId.length > 0 &&
      efficiencyEvidence.domain === "quota_burn_efficiency" &&
      efficiencyEvidence.worst_applicable === "worst_applicable";
    if (!evidenceWellFormed) {
      notes.push("quota_burn_efficiency_evidence_invalid_ignored");
    } else if (
      appliesFromMs > candidate.nowMs ||
      appliesUntilMs < candidate.nowMs + candidate.timeoutMs
    ) {
      notes.push("quota_burn_efficiency_evidence_stale_ignored");
    } else if (candidate.requiredQuota.length === 0) {
      notes.push("quota_burn_efficiency_evidence_without_required_quota_ignored");
    } else {
      verifiedEfficiency = efficiencyScore;
      notes.push("quota_burn_efficiency_evidence_applied");
    }
  }

  const headroom = quota.headroom === null ? NEUTRAL_HEADROOM : quota.headroom;
  const quotaQuality =
    verifiedEfficiency === null
      ? headroom
      : clamp01(
          EFFICIENCY_HEADROOM_WEIGHT * headroom +
            EFFICIENCY_EVIDENCE_WEIGHT * verifiedEfficiency
        );

  // Diagnostic-only price factor (public field, no longer ranked): P = 1 when
  // the routed price is zero, otherwise 1 - ln(1 + routingPrice) / ln(1 + cap),
  // safe when cap is zero. The unified economic term below (P + S) replaces P
  // for ranking; P stays only for observability.
  let priceFactor: number;
  if (routingPriceUsdPerM <= 0) {
    priceFactor = 1;
  } else if (candidate.effectiveCapUsdPerM <= 0) {
    priceFactor = 0;
  } else {
    priceFactor = clamp01(
      1 - Math.log(1 + routingPriceUsdPerM) / Math.log(1 + candidate.effectiveCapUsdPerM)
    );
  }

  // Diagnostic-only speed factor (public field, no longer ranked): S = 1 when
  // expected does not beat the minimum, else the effective headroom over
  // minimum relative to expected. Ranking instead uses raw effectiveTps via the
  // unified economic term below, so speeds above expectedTps still matter even
  // when this diagnostic saturates at 1.
  let speedFactor: number;
  if (candidate.expectedTps <= candidate.minimumTps) {
    speedFactor = 1;
  } else {
    speedFactor = clamp01(
      (candidate.effectiveTps - candidate.minimumTps) /
        (candidate.expectedTps - candidate.minimumTps)
    );
  }

  // Intelligence factor: I = 1 when the rank range is degenerate, else
  // normalized descending rank within [min, max].
  let intelligenceFactor: number;
  if (candidate.intelligenceMaxRank === candidate.intelligenceMinRank) {
    intelligenceFactor = 1;
  } else {
    intelligenceFactor = clamp01(
      1 -
        (candidate.intelligenceRank - candidate.intelligenceMinRank) /
          (candidate.intelligenceMaxRank - candidate.intelligenceMinRank)
    );
  }

  // Unified economic ranking score. It is a ranking utility, never a price or
  // a bill, so it may legitimately be negative. P + S are one economic
  // allocation weighting the marginal exchange of +1 TPS for USD 0.01/M
  // (0.01 * raw effectiveTps - routingPriceUsdPerM); Q adds quota headroom
  // quality and I adds intelligence. priceFactor/speedFactor above are
  // diagnostic-only and no longer appear in the score.
  const score =
    (SCORE_WEIGHTS.P + SCORE_WEIGHTS.S) *
      (SPEED_PRICE_TRADEOFF_USD_PER_M_PER_TPS * candidate.effectiveTps -
        routingPriceUsdPerM) +
    SCORE_WEIGHTS.Q * quotaQuality +
    SCORE_WEIGHTS.I * intelligenceFactor;

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
    headroom,
    quotaQuality,
    priceFactor,
    speedFactor,
    intelligenceFactor,
    score,
    verifiedEfficiency,
    coverageComplete: quota.coverageComplete,
    headroomTrusted: quota.headroomTrusted,
    quota,
    notes,
  };

  return { kind: "accepted", assessment };
}

// ---------------------------------------------------------------------------
// Deterministic conservative ranking
// ---------------------------------------------------------------------------

/**
 * Rank a single tier deterministically by one descending-score pass over every
 * candidate. There is no cheapest-set prefilter and no
 * HEADROOM_CHALLENGE_MIN_GAP admission gate: the unified score already prices
 * the marginal speed/price exchange plus quota headroom quality and
 * intelligence, so a single ordering ranks the whole tier. Stable ties resolve
 * by canonicalId then snapshotId ascending.
 */
function rankTier(candidates: readonly CandidateAssessment[]): CandidateAssessment[] {
  return candidates.slice().sort(
    (a, b) =>
      b.score - a.score ||
      compareLex(a.canonicalId, b.canonicalId) ||
      compareLex(a.snapshotId, b.snapshotId)
  );
}

function toRankedCandidate(
  assessment: CandidateAssessment,
  rank: number
): RankedCandidate {
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
    verifiedEfficiency: assessment.verifiedEfficiency,
    coverageComplete: assessment.coverageComplete,
    headroomTrusted: assessment.headroomTrusted,
    quota: assessment.quota,
    notes: assessment.notes,
  };
}

/**
 * Deterministic conservative auto-routing over a set of candidate snapshots.
 *
 * Confirmed-free accepted candidates are ranked before standard supply. Within
 * each supply class, candidates keep strict tier order (healthy, unknown,
 * strained); each tier is ranked by the single descending-score pass above.
 * Rejected candidates are returned with machine-readable reasons.
 */
export function rankAutoRoutingCandidates(
  inputs: readonly CandidateInput[]
): AutoRoutingResult {
  if (inputs === null || typeof inputs !== "object" || !Array.isArray(inputs)) {
    return { ranked: [], excluded: [] };
  }

  const buckets: Record<SupplyClass, Record<QuotaTier, CandidateAssessment[]>> = {
    confirmed_free: { healthy: [], unknown: [], strained: [] },
    standard: { healthy: [], unknown: [], strained: [] },
  };
  const excluded: ExcludedCandidate[] = [];

  // One immutable selection context: ranking mixes only candidates sharing the
  // snapshotId/nowMs of the first valid (accepted) input.
  let contextSnapshotId: string | null = null;
  let contextNowMs: number | null = null;

  for (const input of inputs) {
    const evaluation = evaluateCandidate(input);
    if (evaluation.kind === "accepted") {
      const assessment = evaluation.assessment;
      if (contextSnapshotId === null) {
        contextSnapshotId = input.snapshotId;
        contextNowMs = input.nowMs;
      }
      if (
        input.snapshotId !== contextSnapshotId ||
        input.nowMs !== contextNowMs
      ) {
        excluded.push({
          snapshotId: assessment.snapshotId,
          canonicalId: assessment.canonicalId,
          reason: "snapshot_context_mismatch",
          detail: `expected snapshotId=${contextSnapshotId}, nowMs=${contextNowMs}`,
        });
        continue;
      }
      buckets[assessment.supplyClass][assessment.tier].push(assessment);
    } else {
      excluded.push({
        snapshotId: evaluation.snapshotId,
        canonicalId: evaluation.canonicalId,
        reason: evaluation.reason,
        detail: evaluation.detail,
      });
    }
  }

  excluded.sort(
    (a, b) =>
      compareLex(a.canonicalId, b.canonicalId) ||
      compareLex(a.snapshotId, b.snapshotId)
  );

  const tierOrder: readonly QuotaTier[] = ["healthy", "unknown", "strained"];
  const supplyOrder: readonly SupplyClass[] = ["confirmed_free", "standard"];
  const rankedAssessments: CandidateAssessment[] = [];
  for (const supplyClass of supplyOrder) {
    for (const tier of tierOrder) {
      const tierRanking = rankTier(buckets[supplyClass][tier]);
      for (const assessment of tierRanking) {
        rankedAssessments.push(assessment);
      }
    }
  }

  const ranked: RankedCandidate[] = rankedAssessments.map((assessment, index) =>
    toRankedCandidate(assessment, index + 1)
  );

  return { ranked, excluded };
}
