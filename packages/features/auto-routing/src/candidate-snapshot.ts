import { type CandidateInput, type RequiredQuotaConstraint, type QuotaEvidence, type MarginalPriceEvidence, type QuotaBurnEfficiencyEvidence, type ConfirmedFreeSupplyEvidence, type UnknownQuotaFloorEvidence } from './types.ts';
// ---------------------------------------------------------------------------
// Candidate evaluation
// ---------------------------------------------------------------------------
/** Deep-copy caller input so later mutation of the caller's objects has no effect. */
export function snapshotCandidate(input: CandidateInput): CandidateInput {
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
  let unknownQuotaFloor: UnknownQuotaFloorEvidence | null = null;
  const quotaFloor = input.unknownQuotaFloor ?? null;
  if (quotaFloor !== null && typeof quotaFloor === "object") {
    unknownQuotaFloor = {
      kind: quotaFloor.kind,
      appliesFromMs: quotaFloor.appliesFromMs,
      appliesUntilMs: quotaFloor.appliesUntilMs,
      source: quotaFloor.source,
      ruleId: quotaFloor.ruleId,
      worst_applicable: quotaFloor.worst_applicable,
    };
  }
  const snapshot: CandidateInput = {
    snapshotId: input.snapshotId,
    canonicalId: input.canonicalId,
    nowMs: input.nowMs,
    referenceUsdPerM: input.referenceUsdPerM,
    effectiveCapUsdPerM: input.effectiveCapUsdPerM,
    timeoutMs: input.timeoutMs,
    minimumTps: input.minimumTps,
    effectiveTps: input.effectiveTps,
    expectedTps: input.expectedTps,
    intelligenceRank: input.intelligenceRank,
    intelligenceMinRank: input.intelligenceMinRank,
    intelligenceExpectedRank: input.intelligenceExpectedRank,
    requiredQuota,
    marginalPrice,
    verifiedEfficiency,
    confirmedFreeSupply,
    unknownQuotaFloor,
  };
  return snapshot;
}
