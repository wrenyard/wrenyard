import type { SupplyAssessment, CandidateEvaluation } from './types.ts';
import { type CandidateInput, type QuotaAssessment, type SupplyClass } from './types.ts';
import { isFiniteNumber } from './numeric.ts';
import { ZERO_QUOTA_HEADROOM } from './constants.ts';
/** Interprets time-bounded free supply and marginal pricing evidence. */
export class SupplyEvidencePolicy {
  assess(candidate: CandidateInput, quota: QuotaAssessment): SupplyAssessment | Extract<CandidateEvaluation, { kind: 'rejected' }> {
    const notes: string[] = [];
    let supplyClass: SupplyClass = "standard";
    let confirmedFreeSupplyApplied = false;
    let confirmedFreeSupplyEvidence: {
      source: string;
      ruleId: string;
    } | null = null;
    // Effective routing price (USD per M output tokens) drives the price factor P.
    // The fixed base-pool discount rate is applied once to the reference unit
    // price; it is independent of peak/off-peak time-of-day pricing. A
    // confirmed-free candidate zeroes it (P = 1); otherwise it may be lowered by
    // a valid worst-applicable marginal price (also scaled by the rate).
    const quotaPoolDiscountRate = candidate.quotaPoolDiscountRate ?? 1;
    let routingPriceUsdPerM = candidate.referenceUsdPerM * quotaPoolDiscountRate;
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
    // The fixed pool discount lowers the automatic unit price once. Report it
    // only when it actually applies and the candidate is not confirmed free
    // (free routing already zeroed the price).
    if (!confirmedFreeSupplyApplied && quotaPoolDiscountRate < 1) {
      notes.push("quota_pool_discount_applied");
    }
    // Marginal price: usable only when it carries verification provenance
    // (nonempty source/ruleId), the conservative worst_applicable marker, and a
    // UTC interval covering [now, now + timeout]. Invalid/stale/insufficient
    // evidence falls back to reference; an otherwise-valid applicable marginal
    // above the listed reference rejects the candidate (compared raw, before the
    // fixed pool discount). A valid applicable marginal is scaled by the fixed
    // pool discount rate. Confirmed-free routing already zeroed the price, so
    // marginal application is skipped in that case.
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
        return { kind: "rejected", snapshotId: candidate.snapshotId, canonicalId: candidate.canonicalId, reason: "marginal_above_reference", detail: `marginal usdPerM=${usdPerM} exceeds the reference ${candidate.referenceUsdPerM}` };
      }
      else {
        routingPriceUsdPerM = usdPerM * quotaPoolDiscountRate;
        marginalApplied = true;
        notes.push("marginal_price_applied");
      }
    }
    // The automatic cap gate compares the discounted reference unit price
    // against the effective cap, never the marginal price: the fixed pool
    // discount preserves the peak safety reference and a marginal price must
    // never bypass the cap.
    if (!confirmedFreeSupplyApplied && candidate.referenceUsdPerM * quotaPoolDiscountRate > candidate.effectiveCapUsdPerM) {
      return { kind: "rejected", snapshotId: candidate.snapshotId, canonicalId: candidate.canonicalId, reason: "reference_above_cap", detail: "effective routing price exceeds the effective cap" };
    }
    const headroom = quota.headroom ?? ZERO_QUOTA_HEADROOM;
    return { notes, supplyClass, confirmedFreeSupplyApplied, confirmedFreeSupplyEvidence, routingPriceUsdPerM, marginalApplied, headroom };
  }
}
