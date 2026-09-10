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
 * Final normalized score weights. The unified ranking score is a convex blend
 * of four bounded [0, 1] factors:
 *   P = price factor (cheaper per-M output price scores higher),
 *   S = speed factor (effective TPS, saturated at 200),
 *   Q = quota headroom quality,
 *   I = intelligence factor.
 *   score = .50*P + .20*S + .20*Q + .10*I, always within [0, 1].
 */
export const SCORE_WEIGHTS = { P: 0.5, S: 0.2, Q: 0.2, I: 0.1 } as const;

/**
 * Fixed continuous price anchors mapping a per-M output token price (USD) to a
 * normalized price factor P in [0, 1] (see interpolatePriceFactor). Lower price
 * yields higher P; prices are interpolated linearly between anchors and any
 * price >= 50 yields P = 0. This is the single source of truth for the price
 * factor and is not a configurable DSL or runtime knob.
 */
export const PRICE_FACTOR_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.5, 0.85],
  [1, 0.75],
  [2, 0.6],
  [6, 0.35],
  [30, 0.05],
  [50, 0],
];

/** Neutral headroom used whenever evidence is genuinely unknown. */
export const NEUTRAL_HEADROOM = 0.5;

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

/**
 * One required quota constraint; null evidence means the constraint is
 * uncovered. A constraint is either a windowed quota constraint (percent +
 * replenishment evidence) or a discriminated monetary balance constraint.
 *
 * Balance evidence comes from the existing Forge balances source (raw
 * `{ currency, amount }` decimal string). A fresh, valid amount strictly
 * greater than zero means not exhausted with neutral quota quality (it never
 * boosts subscription pace); exactly zero blocks; malformed/negative/stale/
 * missing amounts are unknown and never fabricated as zero.
 */
export interface RequiredQuotaConstraint {
  id: string;
  evidence: QuotaEvidence | null;
  /** Present when this constraint is a mandatory monetary balance resource. */
  balance?: BalanceEvidence | null;
  kind?: "quota" | "balance";
}

/** Discriminated monetary balance evidence for one required balance resource. */
export interface BalanceEvidence {
  /** Raw decimal amount string from Forge balances (authoritative). */
  amount: string;
  /** Timestamp (epoch ms) the observation was taken. */
  observedAtMs: number;
  /** How long after observedAtMs the observation is considered fresh. */
  validForMs: number;
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
  effectiveTps: number;
  intelligenceRank: number;
  intelligenceMinRank: number;
  /**
   * Optional expected intelligence rank. When present it must be an integer
   * in [intelligenceMinRank, 3]; it shifts the intelligence factor I to reward
   * matching (or exceeding) the expected rank.
   */
  intelligenceExpectedRank?: number;
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
  | "reset_horizon_beyond_duration"
  | "invalid_balance_amount";

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
  /** Diagnostic speed factor (effective TPS saturated at 200); kept as a public field but no longer ranked. */
  speedFactor: number;
  /** Intelligence factor I used in the score (bounded [0, 1]). */
  intelligenceFactor: number;
  /** Intelligence shortfall diagnostic: max(0, expectedRank - modelRank). Zero
   *  when the model meets or exceeds the expected rank; an absent expected rank
   *  retains the legacy zero shortfall, so shortfall never reshuffles candidates
   *  that carry no expectation. */
  intelligenceShortfall: number;
  /**
   * Unified normalized ranking score (see SCORE_WEIGHTS): score = .50*P + .20*S
   * + .20*Q + .10*I, where every factor is bounded in [0, 1], so the score is
   * itself always within [0, 1].
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
  intelligenceShortfall: number;
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

/**
 * Interpolate the normalized price factor P in [0, 1] from PRICE_FACTOR_ANCHORS.
 * Non-positive or non-finite prices score P = 1 (free); prices at or above the
 * final anchor (>= 50) score P = 0; intermediate prices are linearly blended.
 */
function interpolatePriceFactor(priceUsdPerM: number): number {
  if (!isFiniteNumber(priceUsdPerM) || priceUsdPerM <= 0) return 1;
  const lastAnchor = PRICE_FACTOR_ANCHORS[PRICE_FACTOR_ANCHORS.length - 1];
  if (priceUsdPerM >= lastAnchor[0]) return 0;
  for (let i = 0; i < PRICE_FACTOR_ANCHORS.length - 1; i++) {
    const [p0, v0] = PRICE_FACTOR_ANCHORS[i];
    const [p1, v1] = PRICE_FACTOR_ANCHORS[i + 1];
    if (priceUsdPerM >= p0 && priceUsdPerM <= p1) {
      const t = (priceUsdPerM - p0) / (p1 - p0);
      return v0 + t * (v1 - v0);
    }
  }
  return 0;
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

/**
 * Assesses one mandatory monetary balance resource by the same constraint
 * path as quota windows. A fresh, valid amount strictly greater than zero
 * means not exhausted with neutral quota quality (headroom null -> NEUTRAL
 * HEADROOM; it never boosts subscription pace). Exactly zero blocks. Malformed,
 * negative, non-finite, stale, future or missing amounts are unknown
 * (uncovered): they are never fabricated as zero and never block.
 */
function assessBalanceConstraint(
  nowMs: number,
  id: string,
  balance: BalanceEvidence | null | undefined
): ConstraintAssessment {
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
  // amount > 0: available, neutral quality, never a subscription-pace boost.
  return { id, state: "healthy", headroom: null, rejectCode: null };
}

function assessConstraint(
  nowMs: number,
  constraint: RequiredQuotaConstraint
): ConstraintAssessment {
  if (constraint === null || typeof constraint !== "object") {
    return { id: "", state: "missing", headroom: null, rejectCode: null };
  }
  const id = typeof constraint.id === "string" ? constraint.id : "";
  const balance = constraint.balance;
  if (constraint.kind === "balance" || balance != null) {
    return assessBalanceConstraint(nowMs, id, balance);
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
  /** True when a healthy mandatory balance is the only healthy constraint:
   *  balances are neutral quality and must never be read as full quota. */
  let hasNeutralBalance = false;
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
        else hasNeutralBalance = true;
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
    // A healthy mandatory balance is neutral quality: no full-quota boost.
    headroom = state === "healthy" && !hasNeutralBalance ? 1 : NEUTRAL_HEADROOM;
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
        // A discriminated balance constraint carries balance evidence instead
        // of percent/replenishment quota evidence; copy it defensively.
        if (constraint.kind === "balance") {
          const balance = constraint.balance;
          if (balance === null || balance === undefined || typeof balance !== "object") {
            return { id, evidence: null, kind: "balance", balance: null };
          }
          return {
            id,
            evidence: null,
            kind: "balance",
            balance: {
              amount: balance.amount,
              observedAtMs: balance.observedAtMs,
              validForMs: balance.validForMs,
            },
          };
        }
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
    effectiveTps: input.effectiveTps,
    intelligenceRank: input.intelligenceRank,
    intelligenceMinRank: input.intelligenceMinRank,
    intelligenceExpectedRank: input.intelligenceExpectedRank,
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
    !isFiniteNumber(candidate.effectiveTps) ||
    candidate.minimumTps < 0 ||
    candidate.effectiveTps < 0
  ) {
    return rejected(snapshotId, canonicalId, "invalid_speed", "speed numbers must be finite and non-negative");
  }
  // Only a deficient effectiveTps against the minimumTps hard gate is rejected;
  // the score's speed factor S uses effectiveTps directly (saturated at 200).
  if (candidate.effectiveTps < candidate.minimumTps) {
    return rejected(snapshotId, canonicalId, "speed_below_minimum", "effective TPS is below the minimum TPS");
  }

  // Intelligence ranks are fixed integers on the closed 0..3 scale. The model
  // rank and any optional expected rank must be integers in [0, 3]; the model
  // rank must additionally meet the intelligence minimum, otherwise the
  // candidate is rejected.
  if (
    !Number.isInteger(candidate.intelligenceRank) ||
    !Number.isInteger(candidate.intelligenceMinRank) ||
    candidate.intelligenceMinRank < 0 ||
    candidate.intelligenceMinRank > 3
  ) {
    return rejected(
      snapshotId,
      canonicalId,
      "invalid_intelligence",
      "intelligence ranks must be integers in [0, 3]"
    );
  }
  if (candidate.intelligenceRank < candidate.intelligenceMinRank || candidate.intelligenceRank > 3) {
    return rejected(snapshotId, canonicalId, "intelligence_out_of_range", "intelligence rank is below the minimum or outside [0, 3]");
  }
  // Hard intelligence floor: intelligenceExpectedRank is absent only when
  // undefined; any other value (including null) must be an integer in [0, 3]
  // and at or above the minimum, or the candidate is rejected before any gate.
  const expectedRank = candidate.intelligenceExpectedRank;
  if (expectedRank !== undefined) {
    if (
      !Number.isInteger(expectedRank) ||
      expectedRank < 0 ||
      expectedRank > 3 ||
      expectedRank < candidate.intelligenceMinRank
    ) {
      return rejected(
        snapshotId,
        canonicalId,
        "invalid_intelligence",
        "intelligence expected rank must be an integer in [0, 3] at or above the minimum"
      );
    }
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

  const notes: string[] = [];

  let supplyClass: SupplyClass = "standard";
  let confirmedFreeSupplyApplied = false;
  let confirmedFreeSupplyEvidence: { source: string; ruleId: string } | null = null;
  // Effective routing price (USD per M output tokens) drives the price factor P.
  // A confirmed-free candidate zeroes it (P = 1); otherwise it starts at the
  // reference and may be lowered by a valid worst-applicable marginal price.
  let routingPriceUsdPerM = candidate.referenceUsdPerM;
  let marginalApplied = false;
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
      // Valid confirmed-free evidence passes every hard gate above; it routes
      // for free, so the effective price becomes 0 and the price factor P = 1.
      routingPriceUsdPerM = 0;
      notes.push("confirmed_free_supply_applied");
    }
  }

  // Marginal price: usable only when it carries verification provenance
  // (nonempty source/ruleId), the conservative worst_applicable marker, and a
  // UTC interval covering [now, now + timeout]. Invalid/stale/insufficient
  // evidence falls back to reference; an otherwise-valid applicable marginal
  // above the listed reference rejects the candidate. Confirmed-free routing
  // already zeroed the price, so marginal application is skipped in that case.
  const marginal = candidate.marginalPrice;
  if (marginal !== null && marginal !== undefined && !confirmedFreeSupplyApplied) {
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
  // Quota headroom factor Q in [0, 1]: raw trust headroom, or a blend with
  // verified quota-burn efficiency when present. Q never depends on price/speed.
  const quotaQuality =
    verifiedEfficiency === null
      ? clamp01(headroom)
      : clamp01(
          EFFICIENCY_HEADROOM_WEIGHT * headroom +
            EFFICIENCY_EVIDENCE_WEIGHT * verifiedEfficiency
        );

  // Normalized price factor P in [0, 1] from the fixed continuous price anchors
  // (interpolatePriceFactor): cheaper per-M output price scores higher; price
  // >= 50 scores 0. Confirmed-free routing already zeroed routingPriceUsdPerM.
  const priceFactor = interpolatePriceFactor(routingPriceUsdPerM);

  // Normalized speed factor S in [0, 1]: effective TPS saturated at 200.
  const speedFactor = clamp01(candidate.effectiveTps / 200);

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
  } else {
    intelligenceFactor = clamp01(candidate.intelligenceRank / 3);
  }

  // Typed intelligence shortfall diagnostic: the distance the model rank falls
  // short of the expected rank (never negative). Absent expected rank keeps the
  // legacy zero shortfall so candidates without an expectation are ordered by
  // score exactly as before.
  const intelligenceShortfall = expectedRank === undefined
    ? 0
    : Math.max(0, expectedRank - candidate.intelligenceRank)

  // Unified normalized ranking score in [0, 1]:
  //   score = .50*P + .20*S + .20*Q + .10*I
  // Every factor is bounded in [0, 1], so the score is itself within [0, 1].
  const score =
    SCORE_WEIGHTS.P * priceFactor +
    SCORE_WEIGHTS.S * speedFactor +
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
    intelligenceShortfall,
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
    intelligenceShortfall: assessment.intelligenceShortfall,
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
 * Every accepted candidate is ranked together by a single descending-score
 * pass; supply class and quota tier are retained only as diagnostic fields on
 * each ranked position and are never used as sort keys. Rejected candidates are
 * returned with machine-readable reasons.
 */
export function rankAutoRoutingCandidates(
  inputs: readonly CandidateInput[]
): AutoRoutingResult {
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
      accepted.push(assessment);
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

  // Rank solely by the weighted total score, then stable identity for ties.
  // Recommendation affects the intelligence factor; shortfall remains a
  // diagnostic and is never an independent ranking priority.
  const rankedAssessments = accepted.slice().sort(
    (a, b) =>
      b.score - a.score ||
      compareLex(a.canonicalId, b.canonicalId) ||
      compareLex(a.snapshotId, b.snapshotId)
  );

  const selected = rankedAssessments[0]
  if (selected !== undefined && selected.intelligenceShortfall > 0) {
    selected.notes.push('intelligence_below_expected')
  }

  const ranked: RankedCandidate[] = rankedAssessments.map((assessment, index) =>
    toRankedCandidate(assessment, index + 1)
  );

  return { ranked, excluded };
}
