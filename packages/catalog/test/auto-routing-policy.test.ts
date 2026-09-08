/**
 * Focused node:test coverage for packages/catalog/src/auto-routing-policy.ts.
 *
 * Covers the pure two-file (source + test) contract: quota evidence
 * semantics, full-cycle/rolling aggregation, hard guards, marginal price and
 * verified quota-burn efficiency economic evidence, tier-ordered
 * conservative ranking with ordinary/extreme price-guard challenges,
 * deterministic tie-breaks, and defensive input snapshots.
 *
 * Note: ranking fixtures use synthetic labels ("cursor-grok", "kimi-k3")
 * purely to make canonical/snapshot ids readable. No real provider pricing
 * or quota is asserted anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_WEIGHTS,
  NEUTRAL_HEADROOM,
  assessRequiredQuota,
  evaluateCandidate,
  rankAutoRoutingCandidates,
  type CandidateInput,
  type QuotaEvidence,
  type RequiredQuotaConstraint,
} from "../src/auto-routing-policy.ts";

// ---------------------------------------------------------------------------
// Deterministic clock and evidence builders
// ---------------------------------------------------------------------------

const NOW = 1_000_000_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const W0 = 1_700_000; // shared full-cycle window length

function close(actual: number, expected: number, eps = 1e-9, label = ""): void {
  const delta = Math.abs(actual - expected);
  assert.ok(
    delta <= eps,
    `${label}expected ${expected} but got ${actual} (delta ${delta} > ${eps})`
  );
}

function rollingEv(percent: number): QuotaEvidence {
  return {
    remainingPercent: percent,
    observedAtMs: NOW - MINUTE_MS,
    validForMs: HOUR_MS,
    replenishmentKind: "rolling_partial",
  };
}

function fullCycleEv(percent: number, resetFraction: number): QuotaEvidence {
  const resetHorizonMs = Math.max(1, Math.round(resetFraction * W0));
  return {
    remainingPercent: percent,
    observedAtMs: NOW - 1_000,
    validForMs: HOUR_MS,
    replenishmentKind: "full_cycle",
    resetAtMs: NOW + resetHorizonMs,
    windowMs: W0,
  };
}

function q(id: string, evidence: QuotaEvidence | null): RequiredQuotaConstraint {
  return { id, evidence };
}

/** Full-cycle healthy quota carrying a headroom close to targetH (0.05..1). */
function hQ(targetH: number): QuotaEvidence {
  if (targetH >= 0.8) {
    // reset horizon == window => healthyThreshold 0.8, headroom == remainingRatio.
    return fullCycleEv(targetH * 100, 1);
  }
  // pace term saturates at 1 for r >= e: headroom = 0.75*r + 0.25.
  const remaining = (targetH - 0.25) / 0.75;
  return fullCycleEv(remaining * 100, Math.min(0.3, remaining / 2));
}

function cand(over: Partial<CandidateInput> = {}): CandidateInput {
  const base: CandidateInput = {
    snapshotId: "snap-1",
    canonicalId: "canon-1",
    nowMs: NOW,
    referenceUsdPerM: 1,
    referenceKind: "listed",
    effectiveCapUsdPerM: 100,
    timeoutMs: MINUTE_MS,
    minimumTps: 5,
    expectedTps: 20,
    effectiveTps: 25,
    intelligenceRank: 1,
    intelligenceMinRank: 1,
    intelligenceMaxRank: 5,
    requiredQuota: [q("monthly", fullCycleEv(60, 0.5))],
    marginalPrice: null,
    verifiedEfficiency: null,
  };
  return { ...base, ...over };
}

// Mirrored expectation helpers for the documented factor/score formulas.
function expPriceFactor(routing: number, cap: number): number {
  if (routing <= 0) return 1;
  if (cap <= 0) return 0;
  return Math.min(
    1,
    Math.max(0, 1 - Math.log(1 + routing) / Math.log(1 + cap))
  );
}

function expSpeedFactor(min: number, exp: number, eff: number): number {
  if (exp <= min) return 1;
  return Math.min(1, Math.max(0, (eff - min) / (exp - min)));
}

function expIntelligenceFactor(rank: number, min: number, max: number): number {
  if (max === min) return 1;
  return Math.min(1, Math.max(0, 1 - (rank - min) / (max - min)));
}

function expScore(
  factors: {
    priceFactor: number;
    quotaQuality: number;
    speedFactor: number;
    intelligenceFactor: number;
  }
): number {
  return (
    SCORE_WEIGHTS.P * factors.priceFactor +
    SCORE_WEIGHTS.Q * factors.quotaQuality +
    SCORE_WEIGHTS.S * factors.speedFactor +
    SCORE_WEIGHTS.I * factors.intelligenceFactor
  );
}

function rankedIds(result: { ranked: { canonicalId: string }[] }): string[] {
  return result.ranked.map((r) => r.canonicalId);
}

function expectAccepted(c: CandidateInput) {
  const ev = evaluateCandidate(c);
  assert.equal(ev.kind, "accepted", `expected acceptance for ${c.canonicalId}`);
  return ev.kind === "accepted" ? ev.assessment : null;
}

function expectRejected(c: CandidateInput, reason: string) {
  const ev = evaluateCandidate(c);
  assert.equal(ev.kind, "rejected", `expected rejection for ${c.canonicalId}`);
  return ev.kind === "rejected" ? ev : null;
}

// ---------------------------------------------------------------------------
// Rolling-partial replenishment semantics
// ---------------------------------------------------------------------------

test("rolling_partial healthy/strained/unknown/blocked bands and H", () => {
  const healthy = assessRequiredQuota(NOW, [q("h", rollingEv(90))]);
  assert.equal(healthy.state, "healthy");
  assert.equal(healthy.coverageComplete, true);
  assert.equal(healthy.headroomTrusted, true);
  close(healthy.headroom!, 0.9, 1e-12, "healthy rolling H");
  assert.equal(healthy.constraints[0].state, "healthy");
  close(healthy.constraints[0].headroom!, 0.9, 1e-12, "constraint H");

  const strained = assessRequiredQuota(NOW, [q("s", rollingEv(4))]);
  assert.equal(strained.state, "strained");
  close(strained.headroom!, 0.04, 1e-12, "strained rolling H");
  assert.equal(strained.constraints[0].state, "strained");
  close(strained.constraints[0].headroom!, 0.04, 1e-12, "strained constraint H");

  const unknownMid = assessRequiredQuota(NOW, [q("u", rollingEv(50))]);
  assert.equal(unknownMid.state, "unknown");
  assert.equal(unknownMid.headroomTrusted, false);
  assert.equal(unknownMid.constraints[0].headroom, null);
  assert.equal(unknownMid.headroom, NEUTRAL_HEADROOM);

  const blocked = assessRequiredQuota(NOW, [q("z", rollingEv(0))]);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.headroom, null);
  assert.deepEqual(blocked.blockedConstraintIds, ["z"]);
  assert.equal(blocked.constraints[0].state, "blocked");
  assert.equal(blocked.constraints[0].headroom, 0);
});

test("unknown replenishment kind and missing monthly keep coverage semantics", () => {
  const unknownEv: QuotaEvidence = {
    remainingPercent: 50,
    observedAtMs: NOW - MINUTE_MS,
    validForMs: HOUR_MS,
    replenishmentKind: "unknown",
  };
  const single = assessRequiredQuota(NOW, [q("u", unknownEv)]);
  assert.equal(single.state, "unknown");
  assert.equal(single.coverageComplete, true);
  assert.equal(single.headroom, NEUTRAL_HEADROOM);

  const withMissing = assessRequiredQuota(NOW, [
    q("u", unknownEv),
    q("monthly", null),
  ]);
  assert.equal(withMissing.state, "unknown");
  assert.equal(withMissing.coverageComplete, false);
  assert.equal(withMissing.headroom, NEUTRAL_HEADROOM);
  assert.equal(withMissing.constraints[1].state, "missing");
});

test("empty required quota is unknown with incomplete coverage", () => {
  const empty = assessRequiredQuota(NOW, []);
  assert.equal(empty.state, "unknown");
  assert.equal(empty.coverageComplete, false);
  assert.equal(empty.headroomTrusted, false);
  assert.equal(empty.headroom, NEUTRAL_HEADROOM);
});

test("full_cycle legal reset/window math and headroom values", () => {
  // resetAt - now == window => expectedRemaining 1, threshold 0.8, H == ratio.
  const atWindow = assessRequiredQuota(NOW, [q("w", fullCycleEv(85, 1))]);
  assert.equal(atWindow.state, "healthy");
  assert.equal(atWindow.coverageComplete, true);
  assert.equal(atWindow.headroomTrusted, true);
  close(atWindow.headroom!, 0.85, 1e-9, "full-cycle H=ratio");

  // Partial-cycle pace blend: remaining 0.05 with horizon fraction 1/17 gives
  // pace 0.85 and headroom 0.75*0.05 + 0.25*0.85 = 0.25.
  const low = assessRequiredQuota(NOW, [q("l", fullCycleEv(5, 1 / 17))]);
  assert.equal(low.state, "healthy");
  close(low.headroom!, 0.25, 1e-6, "full-cycle low H");

  // 60% with a 0.3-of-window horizon: pace saturates, H = 0.75*0.6 + 0.25.
  const mid = assessRequiredQuota(NOW, [q("m", fullCycleEv(60, 0.3))]);
  assert.equal(mid.state, "healthy");
  close(mid.headroom!, 0.7, 1e-9, "full-cycle mid H");

  // Slow replenishment that cannot reach healthy stays strained.
  const strainedSlow = assessRequiredQuota(NOW, [q("r", fullCycleEv(30, 0.95))]);
  assert.equal(strainedSlow.state, "strained");
  assert.equal(strainedSlow.coverageComplete, true);
});

test("binding min is taken across joint healthy full-cycle constraints", () => {
  const joint = assessRequiredQuota(NOW, [
    q("wide", fullCycleEv(90, 1)),
    q("tight", fullCycleEv(60, 0.3)),
    q("mid", fullCycleEv(85, 1)),
  ]);
  assert.equal(joint.state, "healthy");
  assert.equal(joint.coverageComplete, true);
  assert.equal(joint.headroomTrusted, true);
  close(joint.headroom!, 0.7, 1e-9, "min across healthy headrooms");
});

// ---------------------------------------------------------------------------
// Invalid / stale / out-of-contract evidence never becomes healthy
// ---------------------------------------------------------------------------

function expectConstraintReject(
  evidence: QuotaEvidence,
  code: string
): void {
  const result = assessRequiredQuota(NOW, [q("bad", evidence)]);
  assert.equal(result.state, "unknown");
  assert.equal(result.coverageComplete, false);
  assert.equal(result.headroomTrusted, false);
  const assessment = result.constraints[0];
  assert.equal(assessment.state, "rejected");
  assert.equal(assessment.rejectCode, code);
}

test("remaining below 0 / above 100 / NaN never becomes healthy", () => {
  const base = (remainingPercent: number): QuotaEvidence => ({
    remainingPercent,
    observedAtMs: NOW - MINUTE_MS,
    validForMs: HOUR_MS,
    replenishmentKind: "rolling_partial",
  });
  expectConstraintReject(base(-0.001), "remaining_percent_out_of_range");
  expectConstraintReject(base(100.001), "remaining_percent_out_of_range");
  expectConstraintReject(base(Number.NaN), "remaining_percent_not_finite");
  expectConstraintReject(base(Number.POSITIVE_INFINITY), "remaining_percent_not_finite");
});

test("future observations and stale evidence are rejected", () => {
  const future: QuotaEvidence = {
    remainingPercent: 90,
    observedAtMs: NOW + 60_000,
    validForMs: HOUR_MS,
    replenishmentKind: "rolling_partial",
  };
  expectConstraintReject(future, "future_observation");

  const stale: QuotaEvidence = {
    remainingPercent: 90,
    observedAtMs: NOW - 2 * HOUR_MS,
    validForMs: HOUR_MS,
    replenishmentKind: "rolling_partial",
  };
  expectConstraintReject(stale, "stale_observation");
});

test("invalid freshness window is rejected", () => {
  const zeroValid: QuotaEvidence = {
    remainingPercent: 90,
    observedAtMs: NOW - 1_000,
    validForMs: 0,
    replenishmentKind: "rolling_partial",
  };
  expectConstraintReject(zeroValid, "invalid_freshness_window");
  const nanObserved: QuotaEvidence = {
    remainingPercent: 90,
    observedAtMs: Number.NaN,
    validForMs: HOUR_MS,
    replenishmentKind: "rolling_partial",
  };
  expectConstraintReject(nanObserved, "observation_time_not_finite");
});

test("full_cycle expired reset, invalid duration, horizon beyond cycle rejected", () => {
  const expiredReset: QuotaEvidence = {
    remainingPercent: 80,
    observedAtMs: NOW - MINUTE_MS,
    validForMs: HOUR_MS,
    replenishmentKind: "full_cycle",
    resetAtMs: NOW - 1,
    windowMs: W0,
  };
  expectConstraintReject(expiredReset, "invalid_reset_time");

  const invalidDuration: QuotaEvidence = {
    remainingPercent: 80,
    observedAtMs: NOW - MINUTE_MS,
    validForMs: HOUR_MS,
    replenishmentKind: "full_cycle",
    resetAtMs: NOW + W0,
    windowMs: 0,
  };
  expectConstraintReject(invalidDuration, "invalid_cycle_duration");

  const horizonBeyond: QuotaEvidence = {
    remainingPercent: 80,
    observedAtMs: NOW - MINUTE_MS,
    validForMs: HOUR_MS,
    replenishmentKind: "full_cycle",
    resetAtMs: NOW + 2 * W0,
    windowMs: W0,
  };
  expectConstraintReject(horizonBeyond, "reset_horizon_beyond_duration");
});

test("zero remaining is blocked before full_cycle reset fields are consulted", () => {
  const zeroFullCycle = assessRequiredQuota(NOW, [
    q("z", {
      remainingPercent: 0,
      observedAtMs: NOW - MINUTE_MS,
      validForMs: HOUR_MS,
      replenishmentKind: "full_cycle",
    }),
  ]);
  assert.equal(zeroFullCycle.state, "blocked");
  assert.deepEqual(zeroFullCycle.blockedConstraintIds, ["z"]);
  assert.equal(zeroFullCycle.constraints[0].rejectCode, null);
});

test("unknown replenishment kind is rejected as invalid kind", () => {
  const badKind = {
    remainingPercent: 50,
    observedAtMs: NOW - MINUTE_MS,
    validForMs: HOUR_MS,
    replenishmentKind: "weekly",
  } as unknown as QuotaEvidence;
  expectConstraintReject(badKind, "invalid_replenishment_kind");
});

// ---------------------------------------------------------------------------
// Negative aggregation: blocked / strained dominate, never silently healthy
// ---------------------------------------------------------------------------

test("blocked + missing stays blocked", () => {
  const result = assessRequiredQuota(NOW, [
    q("zero", rollingEv(0)),
    q("monthly", null),
  ]);
  assert.equal(result.state, "blocked");
  assert.deepEqual(result.blockedConstraintIds, ["zero"]);
  assert.equal(result.coverageComplete, false);
});

test("strained + missing stays strained with incomplete coverage", () => {
  const result = assessRequiredQuota(NOW, [
    q("strain", rollingEv(4)),
    q("monthly", null),
  ]);
  assert.equal(result.state, "strained");
  assert.equal(result.coverageComplete, false);
  assert.equal(result.headroomTrusted, false);
  close(result.headroom!, 0.04, 1e-12, "proven strained H retained");
});

test("strained + unknown stays strained, never neutral .5", () => {
  const result = assessRequiredQuota(NOW, [
    q("strain", rollingEv(4)),
    q("unknown", rollingEv(50)),
  ]);
  assert.equal(result.state, "strained");
  assert.equal(result.coverageComplete, true);
  assert.equal(result.headroomTrusted, false);
  close(result.headroom!, 0.04, 1e-12, "proven strained H beats neutral .5");
});

// ---------------------------------------------------------------------------
// Hard candidate guards
// ---------------------------------------------------------------------------

test("invalid candidates and fields reject with machine reasons", () => {
  expectRejected(
    cand({ snapshotId: "" }),
    "invalid_candidate"
  );
  expectRejected(
    cand({ snapshotId: "ok", canonicalId: "" }),
    "invalid_candidate"
  );
  expectRejected(
    cand({ nowMs: Number.NaN }),
    "invalid_now"
  );
  expectRejected(
    cand({ timeoutMs: -1 }),
    "invalid_timeout"
  );
  expectRejected(
    cand({ referenceKind: "dynamic" as never }),
    "invalid_reference_kind"
  );
  expectRejected(
    cand({ referenceUsdPerM: Number.NaN }),
    "invalid_reference_price"
  );
  expectRejected(
    cand({ referenceUsdPerM: Number.POSITIVE_INFINITY }),
    "invalid_reference_price"
  );
  expectRejected(
    cand({ referenceUsdPerM: -0.01 }),
    "invalid_reference_price"
  );
  expectRejected(
    cand({ effectiveCapUsdPerM: Number.NaN }),
    "invalid_cap"
  );
  expectRejected(
    cand({ effectiveCapUsdPerM: -1 }),
    "invalid_cap"
  );
  expectRejected(
    cand({ referenceUsdPerM: 9, effectiveCapUsdPerM: 5 }),
    "reference_above_cap"
  );
  expectRejected(
    cand({ effectiveTps: 2 }),
    "speed_below_minimum"
  );
  expectRejected(
    cand({ expectedTps: Number.NaN }),
    "invalid_speed"
  );
  expectRejected(
    cand({ intelligenceRank: 99 }),
    "intelligence_out_of_range"
  );
  expectRejected(
    cand({ intelligenceMinRank: 9, intelligenceMaxRank: 5 }),
    "invalid_intelligence"
  );
  expectRejected(
    cand({ intelligenceRank: Number.NaN }),
    "invalid_intelligence"
  );
});

test("listed zero reference is rejected; verified_free zero is the only zero", () => {
  expectRejected(
    cand({ referenceUsdPerM: 0, referenceKind: "listed" }),
    "listed_reference_zero"
  );
  expectRejected(
    cand({ referenceUsdPerM: 0, referenceKind: "listed", effectiveCapUsdPerM: 0 }),
    "listed_reference_zero"
  );
  const free = expectAccepted(
    cand({
      referenceUsdPerM: 0,
      referenceKind: "verified_free",
      effectiveCapUsdPerM: 0,
    })
  );
  assert.equal(free!.routingPriceUsdPerM, 0);
  close(free!.priceFactor, 1, 1e-12, "free price factor");
});

test("cap zero admits only verified-free at zero", () => {
  // Verified-free at zero with cap zero routes with price factor 1.
  const free = expectAccepted(
    cand({
      referenceUsdPerM: 0,
      referenceKind: "verified_free",
      effectiveCapUsdPerM: 0,
    })
  );
  close(free!.score, expScore(free!), 1e-12, "free score");
  // Anything above a zero cap is above-cap, and a positive price under zero
  // cap is impossible since reference > cap rejects first.
  expectRejected(
    cand({ referenceUsdPerM: 0.01, referenceKind: "verified_free", effectiveCapUsdPerM: 0 }),
    "reference_above_cap"
  );
});

test("zero remaining blocks the candidate", () => {
  const blocked = expectRejected(
    cand({ requiredQuota: [q("zero", rollingEv(0))] }),
    "quota_blocked"
  );
  assert.ok(blocked!.detail!.includes("zero"));
});

// ---------------------------------------------------------------------------
// Tier, gate, and incomplete-strained behavior on evaluateCandidate
// ---------------------------------------------------------------------------

test("incomplete-strained reference 9.99 accepted, 10.00 rejected by gate", () => {
  const incompleteStrained = {
    requiredQuota: [q("strain", rollingEv(4)), q("monthly", null)],
  };
  const accepted = expectAccepted(cand({ ...incompleteStrained, referenceUsdPerM: 9.99 }));
  assert.equal(accepted!.tier, "strained");
  assert.equal(accepted!.coverageComplete, false);
  assert.equal(accepted!.headroomTrusted, false);
  close(accepted!.headroom, 0.04, 1e-12, "incomplete-strained H");

  const gated = expectRejected(
    cand({ ...incompleteStrained, referenceUsdPerM: 10 }),
    "reference_price_gate"
  );
  assert.ok(gated!.detail!.includes("tier=strained"));
});

test("unknown tier with reference >= 10 is rejected even when covered", () => {
  const unknownCovered = { requiredQuota: [q("u", rollingEv(50))] };
  const ok = expectAccepted(cand({ ...unknownCovered, referenceUsdPerM: 9.99 }));
  assert.equal(ok!.tier, "unknown");
  expectRejected(
    cand({ ...unknownCovered, referenceUsdPerM: 10 }),
    "reference_price_gate"
  );
  expectRejected(
    cand({ ...unknownCovered, referenceUsdPerM: 10.000001 }),
    "reference_price_gate"
  );
});

test("healthy tiers compute quota metrics and score exactly", () => {
  const a = expectAccepted(
    cand({
      canonicalId: "healthy-a",
      referenceUsdPerM: 2,
      effectiveCapUsdPerM: 20,
      requiredQuota: [q("q", fullCycleEv(60, 0.5))], // H 0.70
    })
  );
  assert.equal(a!.tier, "healthy");
  assert.equal(a!.coverageComplete, true);
  assert.equal(a!.headroomTrusted, true);
  assert.equal(a!.quotaQuality, a!.headroom);
  close(a!.headroom, 0.7, 1e-9, "healthy H");
  close(a!.quotaQuality, 0.7, 1e-9, "Q without efficiency");
  assert.equal(a!.verifiedEfficiency, null);
  assert.equal(a!.marginalApplied, false);
  assert.equal(a!.routingPriceUsdPerM, 2);
  close(a!.priceFactor, expPriceFactor(2, 20), 1e-12, "P");
  close(a!.speedFactor, 1, 1e-12, "S saturated");
  close(a!.intelligenceFactor, 1, 1e-12, "I saturated");
  close(a!.score, expScore(a!), 1e-12, "weighted score");
});

test("expected <= minimum yields S=1; minimum intelligence preferred", () => {
  const sat = expectAccepted(
    cand({ minimumTps: 10, expectedTps: 10, effectiveTps: 12 })
  );
  close(sat!.speedFactor, 1, 1e-12, "expected<=minimum S=1");

  const partial = expectAccepted(
    cand({ minimumTps: 10, expectedTps: 20, effectiveTps: 15 })
  );
  close(partial!.speedFactor, 0.5, 1e-12, "half headroom S=0.5");

  const bestIntel = expectAccepted(
    cand({ intelligenceRank: 1, intelligenceMinRank: 1, intelligenceMaxRank: 5 })
  );
  close(bestIntel!.intelligenceFactor, 1, 1e-12, "min rank I=1");

  const worstIntel = expectAccepted(
    cand({ intelligenceRank: 5, intelligenceMinRank: 1, intelligenceMaxRank: 5 })
  );
  close(worstIntel!.intelligenceFactor, 0, 1e-12, "max rank I=0");

  const degenerate = expectAccepted(
    cand({ intelligenceRank: 3, intelligenceMinRank: 3, intelligenceMaxRank: 3 })
  );
  close(degenerate!.intelligenceFactor, 1, 1e-12, "degenerate range I=1");
});

// ---------------------------------------------------------------------------
// Marginal price economic evidence
// ---------------------------------------------------------------------------

function coveredMarginal(usdPerM: number) {
  return {
    usdPerM,
    appliesFromMs: NOW - MINUTE_MS,
    appliesUntilMs: NOW + MINUTE_MS,
    source: "quota-catalog",
    ruleId: "rule-marginal-1",
    worst_applicable: "worst_applicable" as const,
  };
}

test("valid covered discount applies to routingPrice/P only, never H/tier", () => {
  const withMargin = expectAccepted(
    cand({
      canonicalId: "marginal-1",
      referenceUsdPerM: 5,
      effectiveCapUsdPerM: 20,
      requiredQuota: [q("q", fullCycleEv(60, 0.5))], // H 0.70
      marginalPrice: coveredMarginal(4),
    })
  );
  assert.equal(withMargin!.marginalApplied, true);
  close(withMargin!.routingPriceUsdPerM, 4, 1e-12, "routing price");
  assert.equal(withMargin!.referenceUsdPerM, 5);
  assert.equal(withMargin!.tier, "healthy");
  assert.equal(withMargin!.coverageComplete, true);
  close(withMargin!.headroom, 0.7, 1e-9, "H untouched by discount");
  close(withMargin!.quotaQuality, 0.7, 1e-9, "Q untouched");
  close(withMargin!.priceFactor, expPriceFactor(4, 20), 1e-12, "P on marginal");
  assert.ok(withMargin!.notes.includes("marginal_price_applied"));

  const noMargin = expectAccepted(
    cand({
      canonicalId: "marginal-1",
      referenceUsdPerM: 5,
      effectiveCapUsdPerM: 20,
      requiredQuota: [q("q", fullCycleEv(60, 0.5))],
    })
  );
  close(noMargin!.routingPriceUsdPerM, 5, 1e-12, "reference routing");
  assert.equal(noMargin!.marginalApplied, false);
  // Same H and tier: a discount never hard-admits or re-tiers.
  assert.equal(withMargin!.tier, noMargin!.tier);
  close(withMargin!.headroom, noMargin!.headroom, 1e-12, "H equal");
});

test("valid discount cannot alone create an extreme challenge", () => {
  const baseline = cand({
    canonicalId: "cheap-2",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 6,
    requiredQuota: [q("q", fullCycleEv(5, 1 / 17))], // H ~0.25
  });
  const discounted = cand({
    canonicalId: "marg-3",
    referenceUsdPerM: 5,
    effectiveCapUsdPerM: 6,
    requiredQuota: [q("q", fullCycleEv(60, 0.3))], // H 0.70
    marginalPrice: coveredMarginal(2.9), // big discount, still above baseline
  });
  const d = expectAccepted(discounted);
  assert.equal(d!.marginalApplied, true);
  close(d!.routingPriceUsdPerM, 2.9, 1e-12, "routing after discount");
  close(d!.headroom, 0.7, 1e-9, "H unchanged by discount");

  const result = rankAutoRoutingCandidates([baseline, discounted]);
  // Discounted candidate has H 0.70 vs baseline 0.25: gap 0.45 < 0.5, so it
  // never enters as an extreme challenger; the cheap baseline ranks first.
  assert.deepEqual(rankedIds(result), ["cheap-2", "marg-3"]);
});

test("invalid or stale marginal evidence falls back to reference", () => {
  const missingSource = expectAccepted(
    cand({
      referenceUsdPerM: 5,
      marginalPrice: {
        usdPerM: 4,
        appliesFromMs: NOW - MINUTE_MS,
        appliesUntilMs: NOW + MINUTE_MS,
        source: "",
        ruleId: "rule-1",
        worst_applicable: "worst_applicable",
      },
    })
  );
  assert.equal(missingSource!.marginalApplied, false);
  close(missingSource!.routingPriceUsdPerM, 5, 1e-12, "reference fallback");
  assert.ok(missingSource!.notes.includes("marginal_evidence_invalid_ignored"));

  const partialWindow = expectAccepted(
    cand({
      referenceUsdPerM: 5,
      marginalPrice: {
        usdPerM: 4,
        appliesFromMs: NOW - MINUTE_MS,
        appliesUntilMs: NOW + MINUTE_MS - 1, // does not reach now + timeoutMs
        source: "quota-catalog",
        ruleId: "rule-1",
        worst_applicable: "worst_applicable",
      },
    })
  );
  assert.equal(partialWindow!.marginalApplied, false);
  assert.ok(
    partialWindow!.notes.includes("marginal_interval_does_not_cover_timeout_horizon")
  );

  const notYetApplicable = expectAccepted(
    cand({
      referenceUsdPerM: 5,
      marginalPrice: {
        usdPerM: 4,
        appliesFromMs: NOW + 1,
        appliesUntilMs: NOW + 2 * MINUTE_MS,
        source: "quota-catalog",
        ruleId: "rule-1",
        worst_applicable: "worst_applicable",
      },
    })
  );
  assert.equal(notYetApplicable!.marginalApplied, false);
  assert.ok(
    notYetApplicable!.notes.includes("marginal_interval_does_not_cover_timeout_horizon")
  );

  const wrongMarker = expectAccepted(
    cand({
      referenceUsdPerM: 5,
      marginalPrice: {
        usdPerM: 4,
        appliesFromMs: NOW - MINUTE_MS,
        appliesUntilMs: NOW + MINUTE_MS,
        source: "quota-catalog",
        ruleId: "rule-1",
        worst_applicable: "best_effort" as never,
      },
    })
  );
  assert.equal(wrongMarker!.marginalApplied, false);
  assert.ok(wrongMarker!.notes.includes("marginal_evidence_invalid_ignored"));

  const nanPrice = expectAccepted(
    cand({
      referenceUsdPerM: 5,
      marginalPrice: {
        usdPerM: Number.NaN,
        appliesFromMs: NOW - MINUTE_MS,
        appliesUntilMs: NOW + MINUTE_MS,
        source: "quota-catalog",
        ruleId: "rule-1",
        worst_applicable: "worst_applicable",
      },
    })
  );
  assert.equal(nanPrice!.marginalApplied, false);
});

test("valid covered marginal above the reference rejects", () => {
  expectRejected(
    cand({
      referenceUsdPerM: 5,
      marginalPrice: coveredMarginal(5.01),
    }),
    "marginal_above_reference"
  );
});

test("bare numeric marginal is not evidence", () => {
  // Runtime protection: a non-object marginal is snapshotted to null.
  const bare = expectAccepted(
    cand({
      referenceUsdPerM: 5,
      marginalPrice: 4 as unknown as CandidateInput["marginalPrice"],
    })
  );
  assert.equal(bare!.marginalApplied, false);
  close(bare!.routingPriceUsdPerM, 5, 1e-12, "reference fallback");
});

// ---------------------------------------------------------------------------
// Verified quota-burn efficiency evidence
// ---------------------------------------------------------------------------

function coveredEfficiency(efficiencyScore: number) {
  return {
    efficiencyScore,
    appliesFromMs: NOW - MINUTE_MS,
    appliesUntilMs: NOW + MINUTE_MS,
    source: "quota-ledger",
    ruleId: "rule-eff-1",
    domain: "quota_burn_efficiency" as const,
    worst_applicable: "worst_applicable" as const,
  };
}

test("valid efficiency changes Q only; H/tier/extreme eligibility unchanged", () => {
  const base = cand({
    canonicalId: "eff-a",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 20,
    requiredQuota: [q("q", fullCycleEv(80, 1))], // H 0.80
  });
  const plain = expectAccepted(base);
  assert.equal(plain!.tier, "healthy");
  assert.equal(plain!.headroomTrusted, true);
  close(plain!.headroom, 0.8, 1e-9, "H");
  close(plain!.quotaQuality, 0.8, 1e-9, "Q without efficiency");
  assert.equal(plain!.verifiedEfficiency, null);

  const blended = expectAccepted(
    cand({
      ...base,
      verifiedEfficiency: coveredEfficiency(0.5),
    })
  );
  assert.equal(blended!.tier, "healthy");
  assert.equal(blended!.verifiedEfficiency, 0.5);
  close(blended!.headroom, 0.8, 1e-9, "H untouched by efficiency");
  // 0.85 * H + 0.15 * evidence
  close(blended!.quotaQuality, 0.85 * 0.8 + 0.15 * 0.5, 1e-12, "blended Q");
  close(blended!.priceFactor, plain!.priceFactor, 1e-12, "P unchanged");
  close(blended!.speedFactor, plain!.speedFactor, 1e-12, "S unchanged");
  close(blended!.intelligenceFactor, plain!.intelligenceFactor, 1e-12, "I unchanged");
  assert.ok(blended!.notes.includes("quota_burn_efficiency_evidence_applied"));
});

test("efficiency cannot create extreme challenge by itself", () => {
  const baseline = cand({
    canonicalId: "cheap-eff",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", fullCycleEv(5, 1 / 17))], // H ~0.25
  });
  const highEff = cand({
    canonicalId: "eff-strong",
    referenceUsdPerM: 4,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", fullCycleEv(60, 0.3))], // H 0.70, gap 0.45 < 0.5
    verifiedEfficiency: coveredEfficiency(0.9), // high Q but irrelevant to admission
  });
  const h = expectAccepted(highEff);
  close(h!.quotaQuality, 0.85 * 0.7 + 0.15 * 0.9, 1e-12, "boosted Q");
  const result = rankAutoRoutingCandidates([baseline, highEff]);
  assert.deepEqual(rankedIds(result), ["cheap-eff", "eff-strong"]);
});

test("invalid or stale efficiency evidence is ignored; bare numbers never apply", () => {
  const outOfRange = expectAccepted(
    cand({
      verifiedEfficiency: { ...coveredEfficiency(1.5) },
    })
  );
  assert.equal(outOfRange!.verifiedEfficiency, null);
  assert.ok(outOfRange!.notes.includes("quota_burn_efficiency_evidence_invalid_ignored"));
  close(outOfRange!.quotaQuality, outOfRange!.headroom, 1e-12, "fallback Q=H");

  const staleWindow = expectAccepted(
    cand({
      verifiedEfficiency: {
        ...coveredEfficiency(0.8),
        appliesUntilMs: NOW + MINUTE_MS - 1,
      },
    })
  );
  assert.equal(staleWindow!.verifiedEfficiency, null);
  assert.ok(staleWindow!.notes.includes("quota_burn_efficiency_evidence_stale_ignored"));

  const bare = expectAccepted(
    cand({
      verifiedEfficiency: 0.9 as unknown as CandidateInput["verifiedEfficiency"],
    })
  );
  assert.equal(bare!.verifiedEfficiency, null);
  close(bare!.quotaQuality, bare!.headroom, 1e-12, "bare number ignored");

  const noQuota = expectAccepted(
    cand({
      requiredQuota: [],
      verifiedEfficiency: coveredEfficiency(0.8),
    })
  );
  assert.equal(noQuota!.verifiedEfficiency, null);
  assert.ok(
    noQuota!.notes.includes("quota_burn_efficiency_evidence_without_required_quota_ignored")
  );
});

// ---------------------------------------------------------------------------
// Ordinary vs extreme price-guard challenges (ranking keeps the cheap leader
// unless a complete/trusted headroom gap of >= 0.5 qualifies the pricier one)
// ---------------------------------------------------------------------------

test("cap 6: verified-free H~0.70 keeps the lead over $0.01 H~0.75", () => {
  const free = cand({
    canonicalId: "free-6",
    referenceUsdPerM: 0,
    referenceKind: "verified_free",
    effectiveCapUsdPerM: 6,
    requiredQuota: [q("q", hQ(0.7))],
  });
  const priced = cand({
    canonicalId: "priced-6",
    referenceUsdPerM: 0.01,
    effectiveCapUsdPerM: 6,
    requiredQuota: [q("q", hQ(0.75))],
  });
  const f = expectAccepted(free);
  const p = expectAccepted(priced);
  close(f!.headroom, 0.7, 1e-9, "free H");
  close(p!.headroom, 0.75, 1e-6, "priced H");
  const result = rankAutoRoutingCandidates([priced, free]);
  assert.deepEqual(rankedIds(result), ["free-6", "priced-6"]);
});

test("cap 20: $0.10 H~0.70 keeps the lead over $0.11 H~0.75", () => {
  const cheap = cand({
    canonicalId: "cheap-10c",
    referenceUsdPerM: 0.1,
    effectiveCapUsdPerM: 20,
    requiredQuota: [q("q", hQ(0.7))],
  });
  const expensive = cand({
    canonicalId: "dime-11c",
    referenceUsdPerM: 0.11,
    effectiveCapUsdPerM: 20,
    requiredQuota: [q("q", hQ(0.75))],
  });
  const result = rankAutoRoutingCandidates([expensive, cheap]);
  assert.deepEqual(rankedIds(result), ["cheap-10c", "dime-11c"]);
});

test("cap 60: $2 H~0.70 keeps the lead over $2.10 H~0.75", () => {
  const cheap = cand({
    canonicalId: "cheap-2",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 60,
    requiredQuota: [q("q", hQ(0.7))],
  });
  const expensive = cand({
    canonicalId: "two-10",
    referenceUsdPerM: 2.1,
    effectiveCapUsdPerM: 60,
    requiredQuota: [q("q", hQ(0.75))],
  });
  const result = rankAutoRoutingCandidates([expensive, cheap]);
  assert.deepEqual(rankedIds(result), ["cheap-2", "two-10"]);
});

test("cap 6: $2 H~0.25 vs $2.10 H~0.80 admits and selects the extreme", () => {
  const cheap = cand({
    canonicalId: "cheap-ext",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 6,
    requiredQuota: [q("q", fullCycleEv(5, 1 / 17))], // H ~0.25
  });
  const extreme = cand({
    canonicalId: "extreme-210",
    referenceUsdPerM: 2.1,
    effectiveCapUsdPerM: 6,
    requiredQuota: [q("q", hQ(0.8))], // H 0.80
  });
  const c = expectAccepted(cheap);
  const x = expectAccepted(extreme);
  close(c!.headroom, 0.25, 1e-6, "cheap H");
  close(x!.headroom, 0.8, 1e-9, "extreme H");
  close(x!.score, expScore(x!), 1e-12, "extreme score");
  const result = rankAutoRoutingCandidates([cheap, extreme]);
  assert.deepEqual(rankedIds(result), ["extreme-210", "cheap-ext"]);
});

test("cap 6: $2 H~0.25 vs $4 H~0.85 admits and selects the extreme", () => {
  const cheap = cand({
    canonicalId: "cheap-ext2",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 6,
    requiredQuota: [q("q", fullCycleEv(5, 1 / 17))], // H ~0.25
  });
  const extreme = cand({
    canonicalId: "extreme-4",
    referenceUsdPerM: 4,
    effectiveCapUsdPerM: 6,
    requiredQuota: [q("q", hQ(0.85))], // H 0.85
  });
  const result = rankAutoRoutingCandidates([cheap, extreme]);
  assert.deepEqual(rankedIds(result), ["extreme-4", "cheap-ext2"]);
});

// ---------------------------------------------------------------------------
// Equal-cheapest contentions, synthetic labels, and strict tier ordering
// ---------------------------------------------------------------------------

test("equal-cheapest set contends by quota/speed/intelligence score", () => {
  const a = cand({
    canonicalId: "cont-a",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.8))], // Q 0.80
    minimumTps: 10,
    expectedTps: 20,
    effectiveTps: 15, // S 0.5
    intelligenceRank: 3, // I 0.5
  });
  const b = cand({
    canonicalId: "cont-b",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.9))], // Q 0.90
  });
  const c = cand({
    canonicalId: "cont-c",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.8))], // Q 0.80
  });
  const [ra, rb, rc] = [a, b, c].map((x) => expectAccepted(x)!);
  close(ra.score, expScore(ra), 1e-12, "a score");
  close(rb.score, expScore(rb), 1e-12, "b score");
  close(rc.score, expScore(rc), 1e-12, "c score");
  // Same price: whoever has the higher combined Q/S/I wins, so b > c > a.
  assert.ok(rb.score > rc.score && rc.score > ra.score);

  const result = rankAutoRoutingCandidates([c, a, b]);
  assert.deepEqual(rankedIds(result), ["cont-b", "cont-c", "cont-a"]);
});

test("equal-cheapest high-H candidate blocks a mid-H pricier qualifier", () => {
  const low = cand({
    canonicalId: "low-1",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", fullCycleEv(5, 1 / 17))], // H ~0.25
  });
  const high = cand({
    canonicalId: "high-1",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.85))], // H 0.85, same price as low
  });
  const mid = cand({
    canonicalId: "mid-2",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.8))], // H 0.80
  });

  // Without the equal-cheapest high-H member, mid (gap 0.55 over 0.25)
  // qualifies and jumps the poor cheap candidate in the same round.
  const noHigh = rankAutoRoutingCandidates([low, mid]);
  assert.deepEqual(rankedIds(noHigh), ["mid-2", "low-1"]);

  // With the high-H equal-cheapest present, the baseline max is 0.85 and mid
  // cannot qualify in that round; the high-H equal-cheapest leads instead.
  const withHigh = rankAutoRoutingCandidates([mid, high, low]);
  assert.deepEqual(rankedIds(withHigh), ["high-1", "mid-2", "low-1"]);
});

test("strict tier order healthy > unknown > strained is preserved", () => {
  const healthy = cand({
    canonicalId: "tier-healthy",
    referenceUsdPerM: 5,
    effectiveCapUsdPerM: 20,
    requiredQuota: [q("q", hQ(0.9))],
  });
  const unknown = cand({
    canonicalId: "tier-unknown",
    referenceUsdPerM: 0.4,
    requiredQuota: [q("u", rollingEv(50))],
  });
  const strained = cand({
    canonicalId: "tier-strained",
    referenceUsdPerM: 0.3,
    requiredQuota: [q("s", rollingEv(4))],
  });
  const result = rankAutoRoutingCandidates([strained, unknown, healthy]);
  assert.deepEqual(rankedIds(result), ["tier-healthy", "tier-unknown", "tier-strained"]);
  const tiers = result.ranked.map((r) => r.tier);
  assert.deepEqual(tiers, ["healthy", "unknown", "strained"]);
});

test("synthetic labels: cheaper cursor-grok stays ahead of fuller kimi-k3", () => {
  // Synthetic-only fixture labels: NO real provider pricing/quota is claimed.
  const cursor = cand({
    snapshotId: "snap-1",
    canonicalId: "cursor-grok",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 20,
    requiredQuota: [q("q", hQ(0.79))],
  });
  const kimi = cand({
    snapshotId: "snap-1",
    canonicalId: "kimi-k3",
    referenceUsdPerM: 4,
    effectiveCapUsdPerM: 20,
    requiredQuota: [q("q", hQ(0.97))],
  });
  const cu = expectAccepted(cursor);
  const ki = expectAccepted(kimi);
  close(cu!.headroom, 0.79, 1e-9, "cursor H");
  close(ki!.headroom, 0.97, 1e-9, "kimi H");
  // H gap 0.18 is ordinary (< 0.5), so the cheaper $2 candidate leads.
  const result = rankAutoRoutingCandidates([kimi, cursor]);
  assert.deepEqual(rankedIds(result), ["cursor-grok", "kimi-k3"]);
});

// ---------------------------------------------------------------------------
// Determinism, canonical tie-breaks, snapshot context, defensive copies
// ---------------------------------------------------------------------------

test("exact canonical tie-break resolves equal scores ascending", () => {
  const aa = cand({ canonicalId: "aa", referenceUsdPerM: 2, effectiveCapUsdPerM: 10 });
  const ab = cand({ canonicalId: "ab", referenceUsdPerM: 2, effectiveCapUsdPerM: 10 });
  const ra = expectAccepted(aa)!;
  const rb = expectAccepted(ab)!;
  assert.equal(ra.score, rb.score);

  const forward = rankAutoRoutingCandidates([ab, aa]);
  assert.deepEqual(rankedIds(forward), ["aa", "ab"]);
  const reversed = rankAutoRoutingCandidates([aa, ab]);
  assert.deepEqual(rankedIds(reversed), ["aa", "ab"]);
});

test("deterministic full ordering is invariant to input permutation", () => {
  const d1 = cand({
    canonicalId: "d1",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.9))],
  });
  const d2 = cand({
    canonicalId: "d2",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.8))],
  });
  const d3 = cand({
    canonicalId: "d3",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.8))], // ties d1 price with d1's Q below
  });
  const d4 = cand({
    canonicalId: "d4",
    referenceUsdPerM: 4,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.97))],
  });
  const d5 = cand({
    canonicalId: "d5",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.8))],
  });
  const forwards = [d1, d2, d3, d4, d5];
  const reversed = [d5, d4, d3, d2, d1];
  const shuffled = [d3, d1, d5, d2, d4];

  const a = rankAutoRoutingCandidates(forwards);
  const b = rankAutoRoutingCandidates(reversed);
  const c = rankAutoRoutingCandidates(shuffled);
  assert.deepEqual(rankedIds(a), rankedIds(b));
  assert.deepEqual(rankedIds(b), rankedIds(c));
  assert.equal(a.excluded.length, 0);
});

test("one snapshot context is enforced across accepted candidates", () => {
  const ctxA = cand({
    snapshotId: "ctx",
    canonicalId: "in-a",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.9))],
  });
  const ctxB = cand({
    snapshotId: "ctx",
    canonicalId: "in-b",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.85))],
  });
  const other = cand({
    snapshotId: "other-snap",
    canonicalId: "out-1",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", hQ(0.8))],
  });

  const result = rankAutoRoutingCandidates([ctxA, other, ctxB]);
  assert.deepEqual(rankedIds(result), ["in-b", "in-a"]);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].canonicalId, "out-1");
  assert.equal(result.excluded[0].reason, "snapshot_context_mismatch");
  assert.ok(result.excluded[0].detail!.includes("snapshotId=ctx"));

  // First accepted input fixes the context: leading with `other` flips it.
  const flipped = rankAutoRoutingCandidates([other, ctxA, ctxB]);
  assert.deepEqual(rankedIds(flipped), ["out-1"]);
  assert.equal(flipped.excluded.length, 2);
  assert.ok(flipped.excluded.every((e) => e.reason === "snapshot_context_mismatch"));
});

test("same snapshot with a different nowMs is excluded as context mismatch", () => {
  const t1 = cand({
    canonicalId: "now-a",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", rollingEv(90))],
  });
  const t2 = cand({
    canonicalId: "now-b",
    nowMs: NOW + 60_000,
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", rollingEv(90))],
  });
  const result = rankAutoRoutingCandidates([t1, t2]);
  assert.deepEqual(rankedIds(result), ["now-a"]);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].reason, "snapshot_context_mismatch");
});

test("original inputs mutated after ranking never change returned results", () => {
  const dsA = cand({
    canonicalId: "ds-a",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", fullCycleEv(60, 0.5))], // H 0.70
    marginalPrice: coveredMarginal(1.5), // discounted but still > cheapest? no: 1.5 < 2
  });
  const dsB = cand({
    canonicalId: "ds-b",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    requiredQuota: [q("q", fullCycleEv(85, 1))], // H 0.85
  });
  const inputs = [dsA, dsB];

  const first = rankAutoRoutingCandidates(inputs);
  const firstJson = JSON.stringify(first);
  const firstHeadroomA = first.ranked.find((r) => r.canonicalId === "ds-a")!.headroom;
  close(firstHeadroomA, 0.7, 1e-9, "original ds-a H");

  // Mutate the caller-owned inputs deeply after ranking returned.
  dsA.requiredQuota[0].evidence!.remainingPercent = 0; // now blocks ds-a
  dsA.referenceUsdPerM = 1.1;
  dsB.marginalPrice = coveredMarginal(0.5);

  // The earlier result is a defensive snapshot: nothing changed.
  assert.equal(JSON.stringify(first), firstJson);
  assert.equal(
    first.ranked.find((r) => r.canonicalId === "ds-a")!.headroom,
    firstHeadroomA
  );
  close(firstHeadroomA, 0.7, 1e-9, "snapshotted H survives caller mutation");

  // A fresh call re-snapshots the (mutated) inputs and differs accordingly.
  const second = rankAutoRoutingCandidates(inputs);
  assert.deepEqual(
    second.excluded.map((e) => [e.canonicalId, e.reason]),
    [["ds-a", "quota_blocked"]]
  );
  assert.deepEqual(rankedIds(second), ["ds-b"]);
  assert.notEqual(JSON.stringify(second), firstJson);
});

test("evaluateCandidate returns fresh independent results per call", () => {
  const input = cand({ canonicalId: "fresh", referenceUsdPerM: 2, effectiveCapUsdPerM: 10 });
  const first = evaluateCandidate(input);
  const second = evaluateCandidate(input);
  assert.notEqual(first, second);
  assert.deepEqual(first, second);

  const assessment = first.kind === "accepted" ? first.assessment : null;
  assert.ok(assessment);
  close(assessment!.headroom, 0.7, 1e-9, "headroom snapshot");

  // Mutating the caller-owned input leaves the earlier result intact, and a
  // fresh call reflects the mutated quota.
  input.requiredQuota[0].evidence!.remainingPercent = 0;
  const after = evaluateCandidate(input);
  assert.deepEqual(first, second); // prior result untouched
  assert.equal(after.kind, "rejected");
  assert.equal(after.kind === "rejected" ? after.reason : "", "quota_blocked");
  assert.equal(first.kind === "accepted" ? first.assessment.headroom : null, assessment!.headroom);
});

// ---------------------------------------------------------------------------
// Provider-confirmed free supply ordering
// ---------------------------------------------------------------------------

function confirmedFreeSupply() {
  return {
    kind: "confirmed_free" as const,
    appliesFromMs: NOW - MINUTE_MS,
    appliesUntilMs: NOW + HOUR_MS,
    source: "provider-snapshot",
    ruleId: "confirmed-free-fixture",
  };
}

test("confirmed-free unknown quota precedes standard healthy quota", () => {
  const freeUnknown = cand({
    canonicalId: "free-unknown",
    requiredQuota: [q("rolling", rollingEv(50))],
    confirmedFreeSupply: confirmedFreeSupply(),
  });
  const standardHealthy = cand({
    canonicalId: "standard-healthy",
    requiredQuota: [q("rolling", rollingEv(90))],
  });

  const result = rankAutoRoutingCandidates([standardHealthy, freeUnknown]);
  assert.deepEqual(rankedIds(result), ["free-unknown", "standard-healthy"]);
  assert.equal(result.ranked[0].supplyClass, "confirmed_free");
  assert.equal(result.ranked[0].confirmedFreeSupplyApplied, true);
  assert.deepEqual(result.ranked[0].confirmedFreeSupplyEvidence, {
    source: "provider-snapshot",
    ruleId: "confirmed-free-fixture",
  });
  assert.equal(result.ranked[1].supplyClass, "standard");
});

test("blocked confirmed-free supply remains excluded", () => {
  const result = rankAutoRoutingCandidates([
    cand({
      canonicalId: "free-blocked",
      requiredQuota: [q("rolling", rollingEv(0))],
      confirmedFreeSupply: confirmedFreeSupply(),
    }),
  ]);
  assert.deepEqual(rankedIds(result), []);
  assert.deepEqual(
    result.excluded.map((entry) => [entry.canonicalId, entry.reason]),
    [["free-blocked", "quota_blocked"]]
  );
});

test("missing, invalid, or expired free evidence stays standard", () => {
  const ordinaryIncluded = expectAccepted(
    cand({ canonicalId: "included-subscription", confirmedFreeSupply: null })
  )!;
  assert.equal(ordinaryIncluded.supplyClass, "standard");
  assert.equal(ordinaryIncluded.confirmedFreeSupplyApplied, false);

  const expired = expectAccepted(
    cand({
      canonicalId: "expired-free",
      confirmedFreeSupply: {
        ...confirmedFreeSupply(),
        appliesUntilMs: NOW + 1,
      },
    })
  )!;
  assert.equal(expired.supplyClass, "standard");
  assert.ok(
    expired.notes.includes("confirmed_free_supply_interval_does_not_cover_timeout_horizon")
  );

  const unknownEnvironment = expectAccepted(
    cand({
      canonicalId: "unknown-environment",
      confirmedFreeSupply: {
        ...confirmedFreeSupply(),
        kind: "unknown" as never,
      },
    })
  )!;
  assert.equal(unknownEnvironment.supplyClass, "standard");
  assert.ok(unknownEnvironment.notes.includes("confirmed_free_supply_evidence_invalid_ignored"));
});

test("confirmed-free evidence never bypasses hard gates", () => {
  const free = confirmedFreeSupply();
  expectRejected(
    cand({
      canonicalId: "free-over-cap",
      referenceUsdPerM: 7,
      effectiveCapUsdPerM: 6,
      confirmedFreeSupply: free,
    }),
    "reference_above_cap"
  );
  expectRejected(
    cand({
      canonicalId: "free-too-slow",
      minimumTps: 60,
      expectedTps: 80,
      effectiveTps: 59,
      confirmedFreeSupply: free,
    }),
    "speed_below_minimum"
  );
  expectRejected(
    cand({
      canonicalId: "free-missing-price",
      referenceUsdPerM: undefined as unknown as number,
      confirmedFreeSupply: free,
    }),
    "invalid_reference_price"
  );
});
