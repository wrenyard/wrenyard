import type { SupplyAssessment } from './types.ts';
import { type CandidateInput, type QuotaAssessment, type SupplyClass } from './types.ts';
import { isFiniteNumber } from './numeric.ts';
import { ZERO_QUOTA_HEADROOM } from './constants.ts';
/** Interprets time-bounded free supply, marginal pricing and efficiency evidence. */
export class SupplyEvidencePolicy {
  assess(candidate: CandidateInput, quota: QuotaAssessment): SupplyAssessment {
    const notes: string[] = [];
    let supplyClass: SupplyClass = "standard";
    let confirmedFreeSupplyApplied = false;
    let confirmedFreeSupplyEvidence: {
      source: string;
      ruleId: string;
    } | null = null;
    // Effective routing price (USD per M output tokens) drives the price factor P.
    // A confirmed-free candidate zeroes it (P = 1); otherwise it starts at the
    // reference and may be lowered by a valid worst-applicable marginal price.
    let routingPriceUsdPerM = candidate.referenceUsdPerM;
    let marginalApplied = false;
    const freeSupply = candidate.confirmedFreeSupply;
    if (freeSupply !== null && freeSupply !== undefined) {
      const freeEvidenceWellFormed = freeSupply.kind === "confirmed_free" &&
        isFiniteNumber(freeSupply.appliesFromMs) &&
        isFiniteNumber(freeSupply.appliesUntilMs) &&
        freeSupply.appliesFromMs <= freeSupply.appliesUntilMs &&
        typeof freeSupply.source === "string" &&
        freeSupply.source.length > 0 &&
        typeof freeSupply.ruleId === "string" &&
        freeSupply.ruleId.length > 0;
      if (!freeEvidenceWellFormed) {
        notes.push("confirmed_free_supply_evidence_invalid_ignored");
      }
      else if (freeSupply.appliesFromMs > candidate.nowMs ||
        freeSupply.appliesUntilMs < candidate.nowMs + candidate.timeoutMs) {
        notes.push("confirmed_free_supply_interval_does_not_cover_timeout_horizon");
      }
      else {
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
      const evidenceWellFormed = isFiniteNumber(usdPerM) &&
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
      }
      else if (appliesFromMs > candidate.nowMs ||
        appliesUntilMs < candidate.nowMs + candidate.timeoutMs) {
        notes.push("marginal_interval_does_not_cover_timeout_horizon");
      }
      else if (usdPerM > candidate.referenceUsdPerM) {
        return rejected(snapshotId, canonicalId, "marginal_above_reference", `marginal usdPerM=${usdPerM} exceeds the reference ${candidate.referenceUsdPerM}`);
      }
      else {
        routingPriceUsdPerM = usdPerM;
        marginalApplied = true;
        notes.push("marginal_price_applied");
      }
    }
    if (!confirmedFreeSupplyApplied && candidate.referenceUsdPerM > candidate.effectiveCapUsdPerM) {
      return rejected(snapshotId, canonicalId, "reference_above_cap", "effective routing price exceeds the effective cap");
    }
    // Verified quota-burn efficiency adjusts Q only; it never changes H, tier,
    // or any eligibility gate. It is applied only while every field is valid and
    // nonempty, the interval covers [now, now + timeout], and the aggregate quota
    // carries a trusted positive headroom; with no required quota constraint — or
    // with an unknown/balance-only aggregate headroom — there is no trusted quota
    // to blend against, so Q keeps the raw zero headroom and no bonus is granted.
    // A bare numeric credit is never accepted as evidence.
    let verifiedEfficiency: number | null = null;
    const efficiencyEvidence = candidate.verifiedEfficiency;
    if (efficiencyEvidence !== null &&
      efficiencyEvidence !== undefined &&
      typeof efficiencyEvidence === "object") {
      const efficiencyScore = efficiencyEvidence.efficiencyScore;
      const appliesFromMs = efficiencyEvidence.appliesFromMs;
      const appliesUntilMs = efficiencyEvidence.appliesUntilMs;
      const source = efficiencyEvidence.source;
      const ruleId = efficiencyEvidence.ruleId;
      const evidenceWellFormed = isFiniteNumber(efficiencyScore) &&
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
      }
      else if (appliesFromMs > candidate.nowMs ||
        appliesUntilMs < candidate.nowMs + candidate.timeoutMs) {
        notes.push("quota_burn_efficiency_evidence_stale_ignored");
      }
      else if (candidate.requiredQuota.length === 0) {
        notes.push("quota_burn_efficiency_evidence_without_required_quota_ignored");
      }
      else if (!quota.headroomTrusted || quota.headroom === null || quota.headroom <= 0) {
        // Efficiency may only modulate a trusted, positive headroom: an aggregate
        // unknown quota or balance-only quota (headroom 0) must never receive
        // an efficiency bonus.
        notes.push("quota_burn_efficiency_evidence_without_trusted_headroom_ignored");
      }
      else {
        verifiedEfficiency = efficiencyScore;
        notes.push("quota_burn_efficiency_evidence_applied");
      }
    }
    const headroom = quota.headroom === null ? ZERO_QUOTA_HEADROOM : quota.headroom;
    // A provider-verified unknown-quota floor credits Q when the aggregate
    // carries no trusted headroom, so a login whose quota simply cannot be
    // observed is not ranked as if it were exhausted. It never raises a trusted
    // headroom, never rescues a blocked candidate, and never changes H, the tier,
    // coverage or any eligibility gate.
    let unknownQuotaFloorApplied = false;
    const quotaFloor = candidate.unknownQuotaFloor;
    if (quotaFloor !== null && quotaFloor !== undefined) {
      const floorEvidenceWellFormed = quotaFloor.kind === "unknown_quota_floor" &&
        isFiniteNumber(quotaFloor.appliesFromMs) &&
        isFiniteNumber(quotaFloor.appliesUntilMs) &&
        quotaFloor.appliesFromMs <= quotaFloor.appliesUntilMs &&
        typeof quotaFloor.source === "string" &&
        quotaFloor.source.length > 0 &&
        typeof quotaFloor.ruleId === "string" &&
        quotaFloor.ruleId.length > 0 &&
        quotaFloor.worst_applicable === "worst_applicable";
      if (!floorEvidenceWellFormed) {
        notes.push("unknown_quota_floor_evidence_invalid_ignored");
      }
      else if (quotaFloor.appliesFromMs > candidate.nowMs ||
        quotaFloor.appliesUntilMs < candidate.nowMs + candidate.timeoutMs) {
        notes.push("unknown_quota_floor_interval_does_not_cover_timeout_horizon");
      }
      else if (quota.headroomTrusted) {
        notes.push("unknown_quota_floor_with_trusted_headroom_ignored");
      }
      else {
        unknownQuotaFloorApplied = true;
        notes.push("unknown_quota_floor_applied");
      }
    }
    return { notes, supplyClass, confirmedFreeSupplyApplied, confirmedFreeSupplyEvidence, routingPriceUsdPerM, marginalApplied, verifiedEfficiency, headroom, unknownQuotaFloorApplied };
  }
}
