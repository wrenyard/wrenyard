import type { IntelligenceTier, ModelCapability, ReasoningEffort } from '@wrenyard/models';
import type { DispatchPlan, ModelDefinition, SpeedEvidence } from '@wrenyard/providers/base';
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
/** Editable weight set: four required keys, each finite in [0, 1], summing to 1. */
export interface ScoreWeights {
  P: number;
  S: number;
  Q: number;
  I: number;
}
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ReplenishmentKind = "full_cycle" | "rolling_partial" | "unknown";
/**
 * The single four-level quota state of a route, ordered from best to worst for
 * ranking: abundant > sufficient > insufficient > exhausted.
 */
export type QuotaState = "abundant" | "sufficient" | "insufficient" | "exhausted";
/**
 * How a route's numbers were obtained. `unknown_by_design` is a provider
 * declaration that usage is never exposed; `not_obtained` is a failed, refused
 * or stale read that may still reuse its last measurement for a grace period.
 */
export type QuotaEvidenceStatus = "measured" | "unknown_by_design" | "not_obtained";
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
 * Balance evidence comes from the existing Wrenyard balances source (raw
 * `{ currency, amount }` decimal string). A fresh, valid amount strictly
 * greater than zero means not exhausted with zero quota quality (it never
 * boosts subscription pace); exactly zero blocks; malformed/negative/stale/
 * missing amounts are unknown and never fabricated as zero.
 */
export interface RequiredQuotaConstraint {
  id: string;
  evidence: QuotaEvidence | null;
  /** Present when this constraint is a mandatory monetary balance resource. */
  balance?: BalanceEvidence | null;
  kind?: "quota" | "balance";
  /**
   * How this constraint's evidence was obtained. Absent means derived from the
   * evidence itself: measured when fresh evidence is present, otherwise not
   * obtained.
   */
  evidenceStatus?: QuotaEvidenceStatus;
  /**
   * Copied from the pool declaration: the provider never exposes usage for this
   * resource, so the constraint is unknown by design and never abundant.
   */
  usageUnknown?: boolean;
  /**
   * Gateway observed a quota_exhausted fault on this pool; cleared by a later
   * successful request on the same pool.
   */
  observedExhausted?: boolean;
}
/** Discriminated balance evidence for one required balance resource. */
export interface BalanceEvidence {
  /** Raw decimal amount string from Wrenyard balances (authoritative). Absent
   *  only on a provider-declared unlimited row. */
  amount?: string;
  /** ISO-4217 currency code; selects the low-balance threshold. Absent on a
   *  non-currency unit balance (e.g. Credits), which has no threshold. */
  currency?: string | null;
  /** Non-currency unit label carried for diagnostics; never a currency. */
  unit?: string;
  /** Provider-declared unlimited balance: usable while fresh, never a fake
   *  large amount. */
  unlimited?: boolean;
  /** Timestamp (epoch ms) the observation was taken. */
  observedAtMs: number;
  /** How long after observedAtMs the observation is considered fresh. */
  validForMs: number;
}
/** Canonical conservative marker required on every routed evidence object. */
export type WorstApplicableMarker = "worst_applicable";
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
  /** Listed reference output price, USD per M tokens. */
  referenceUsdPerM: number;
  /**
   * Optional fixed base-pool discount rate for automatic routing. It is applied
   * once to the unit price for the automatic cap and ranking, and is independent
   * of peak/off-peak time-of-day pricing. Absent means 1.
   */
  quotaPoolDiscountRate?: number;
  /** Effective reference cap in the same USD/M units. */
  effectiveCapUsdPerM: number;
  /** Routing horizon that the marginal interval must fully cover. */
  timeoutMs: number;
  minimumTps: number;
  effectiveTps: number;
  /**
   * Optional task-declared expected TPS. It raises the speed saturation point
   * to SPEED_SATURATION_BASE_TPS + expectedTps; absent means the bare base. It
   * is a scoring preference only and never gates eligibility - minimumTps
   * remains the sole speed hard gate.
   */
  expectedTps?: number;
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
  confirmedFreeSupply?: ConfirmedFreeSupplyEvidence | null;
}
/** Per-constraint quota state; `rejectCode` carries the reason when unusable. */
export type ConstraintState = QuotaState;
export type ConstraintRejectCode = "invalid_now" | "remaining_percent_not_finite" | "remaining_percent_out_of_range" | "observation_time_not_finite" | "future_observation" | "invalid_freshness_window" | "stale_observation" | "invalid_replenishment_kind" | "invalid_reset_time" | "invalid_cycle_duration" | "reset_horizon_beyond_duration" | "invalid_balance_amount";
export interface ConstraintAssessment {
  id: string;
  state: ConstraintState;
  /** How this constraint's numbers were obtained. */
  evidenceStatus: QuotaEvidenceStatus;
  /** Headroom in [0, 1]; null when the state carries no determinate headroom. */
  headroom: number | null;
  /** Machine-readable reason when the evidence is unusable. */
  rejectCode: ConstraintRejectCode | null;
}
/** Aggregate quota assessment across all required constraints. */
export interface QuotaAssessment {
  state: QuotaState;
  /** Route-level evidence status: the worst status across constraints. */
  evidence: QuotaEvidenceStatus;
  /** Timestamp of the newest observation, or null when nothing was observed. */
  measuredAt: number | null;
  exhaustedConstraintIds: string[];
  coverageComplete: boolean;
  headroom: number | null;
  constraints: ConstraintAssessment[];
}
export type ExcludedReason = "invalid_candidate" | "invalid_now" | "invalid_timeout" | "invalid_reference_price" | "invalid_cap" | "reference_above_cap" | "invalid_speed" | "speed_below_minimum" | "invalid_intelligence" | "intelligence_out_of_range" | "quota_exhausted" | "marginal_above_reference" | "snapshot_context_mismatch";
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
  /** The route's quota state; the primary ranking tier. */
  tier: QuotaState;
  referenceUsdPerM: number;
  routingPriceUsdPerM: number;
  marginalApplied: boolean;
  supplyClass: SupplyClass;
  confirmedFreeSupplyApplied: boolean;
  confirmedFreeSupplyEvidence: {
    source: string;
    ruleId: string;
  } | null;
  /** Raw headroom H feeding the quota headroom factor Q. */
  headroom: number;
  /** Mean quota-pool factor Q used in the score. */
  quotaQuality: number;
  /** Diagnostic price factor; kept as a public field but no longer ranked. */
  priceFactor: number;
  /** Diagnostic speed factor (effective TPS saturated at SPEED_SATURATION_BASE_TPS plus the task's expected TPS); kept as a public field but no longer ranked. */
  speedFactor: number;
  /** Intelligence factor I used in the score (bounded [0, 1]). */
  intelligenceFactor: number;
  /** Intelligence shortfall diagnostic: max(0, expectedRank - modelRank). Zero
   *  when the model meets or exceeds the expected rank; an absent expected rank
   *  retains the legacy zero shortfall, so shortfall never reshuffles candidates
   *  that carry no expectation. */
  intelligenceShortfall: number;
  /**
   * Unified normalized ranking score (see SCORE_WEIGHTS): score = weights.P*P
   * + weights.S*S + weights.Q*Q + weights.I*I, where every factor is bounded
   * in [0, 1], so the score is itself always within [0, 1]. The exact weights
   * used are carried on `weights`.
   */
  score: number;
  /** Exact weight set used for this assessment's score. */
  weights: ScoreWeights;
  coverageComplete: boolean;
  quota: QuotaAssessment;
  notes: string[];
}
export type CandidateEvaluation = {
  kind: "accepted";
  assessment: CandidateAssessment;
} | {
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
  tier: QuotaState;
  score: number;
  referenceUsdPerM: number;
  routingPriceUsdPerM: number;
  marginalApplied: boolean;
  supplyClass: SupplyClass;
  confirmedFreeSupplyApplied: boolean;
  confirmedFreeSupplyEvidence: {
    source: string;
    ruleId: string;
  } | null;
  headroom: number;
  quotaQuality: number;
  priceFactor: number;
  speedFactor: number;
  intelligenceFactor: number;
  intelligenceShortfall: number;
  /** Exact weight set used for this candidate's score. */
  weights: ScoreWeights;
  coverageComplete: boolean;
  quota: QuotaAssessment;
  notes: string[];
}
export interface AutoRoutingResult {
  ranked: RankedCandidate[];
  excluded: ExcludedCandidate[];
}
export interface TaskDispatchRequirements {
  /** Estimated rendered prompt tokens; runtime-only, never a user setting. */
  inputTokens?: number;
  expectedTps?: number;
  minimumTps?: number;
  intelligenceMin?: IntelligenceTier;
  intelligenceExpected?: IntelligenceTier;
  maxOutputUsdPerMillion?: number;
  /** Required input support. Missing/unknown model support fails admission. */
  requiredCapabilities?: readonly ModelCapability[];
  excludeModelIds?: readonly string[];
  excludeProfileIds?: readonly string[];
  excludeClientIds?: readonly string[];
  excludeProviderIds?: readonly string[];
  /** Hidden requirement: the dispatched plan must admit native web search.
   * This is enforced as a hard gate and fails closed for gateway and unknown
   * combinations; it is not surfaced in any search settings UI. */
  requiresWebSearch?: boolean;
  /** Expected reasoning-effort level. Reasoning effort is a resolved runtime
   * PARAMETER, never an eligibility or ranking constraint: the expected level
   * adapts to the nearest usable level (only levels declared by the model AND
   * explicitly mapped for the exact runtime are usable; otherwise the request
   * withholds reasoning effort and no transport is invented). Task dispatch
   * declarations always carry one; the catalog omits it only for enumeration. */
  expectedReasoningEffort?: ReasoningEffort;
  /** Requests the provider's verified Fast mode for the selected model. */
  fast?: boolean;
}
export interface DispatchResolution {
  plan: DispatchPlan;
  model: ModelDefinition;
  speed: SpeedEvidence;
  satisfaction: number;
  rank: number;
}
export type ConstrainedDispatch = {
  ok: true;
  selected: DispatchResolution;
  considered: number;
} | {
  ok: false;
  reason: 'no-eligible-candidate';
  considered: number;
};
/** Validated supply evidence passed from admission to scoring. */
export type SupplyAssessment = Pick<CandidateAssessment, 'notes' | 'supplyClass' | 'confirmedFreeSupplyApplied' | 'confirmedFreeSupplyEvidence' | 'routingPriceUsdPerM' | 'marginalApplied' | 'headroom'>;
export type CandidateScore = Pick<CandidateAssessment, 'quotaQuality' | 'priceFactor' | 'speedFactor' | 'intelligenceFactor' | 'intelligenceShortfall' | 'score'>;
