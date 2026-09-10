/**
 * Focused node:test coverage for packages/catalog/src/auto-routing-policy.ts.
 *
 * Covers the pure two-file (source + test) contract: quota evidence
 * semantics, full-cycle/rolling aggregation, hard guards, marginal price and
 * verified quota-burn efficiency economic evidence, and the approved normalized
 * ranking score:
 *   score = .50*P + .20*S + .20*Q + .10*I
 * where P is the continuous price-factor from fixed anchors, S = min(TPS/200,1),
 * Q is quota headroom quality, and I is the intelligence factor. Every factor is
 * bounded in [0, 1], so the score is always within [0, 1]. Ranking is one global
 * deterministic descending-score pass; supply class and quota tier are retained
 * only as diagnostic fields and never as sort keys.
 *
 * Note: ranking fixtures use synthetic labels ("ds-flash-like",
 * "glm-flash-like") purely to make canonical/snapshot ids readable. No real
 * provider pricing or quota is asserted anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_WEIGHTS,
  PRICE_FACTOR_ANCHORS,
  NEUTRAL_HEADROOM,
  EFFICIENCY_HEADROOM_WEIGHT,
  EFFICIENCY_EVIDENCE_WEIGHT,
  assessRequiredQuota,
  evaluateCandidate,
  rankAutoRoutingCandidates,
  type CandidateInput,
  type CandidateAssessment,
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
    effectiveTps: 25,
    intelligenceRank: 3,
    intelligenceMinRank: 0,
    requiredQuota: [q("monthly", fullCycleEv(60, 0.5))],
    marginalPrice: null,
    verifiedEfficiency: null,
  };
  return { ...base, ...over };
}

// Mirrored expectation helpers for the approved normalized diagnostic/score
// formulas. interpPrice mirrors interpolatePriceFactor exactly: P is the
// continuous anchor-interpolated price factor; S saturates effective TPS at 200.
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function interpPrice(priceUsdPerM: number): number {
  if (!Number.isFinite(priceUsdPerM) || priceUsdPerM <= 0) return 1;
  const anchors = PRICE_FACTOR_ANCHORS;
  const last = anchors[anchors.length - 1];
  if (priceUsdPerM >= last[0]) return 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    const [p0, v0] = anchors[i];
    const [p1, v1] = anchors[i + 1];
    if (priceUsdPerM >= p0 && priceUsdPerM <= p1) {
      const t = (priceUsdPerM - p0) / (p1 - p0);
      return v0 + t * (v1 - v0);
    }
  }
  return 0;
}

function expScore(
  input: CandidateInput,
  assessment: CandidateAssessment
): number {
  const P = interpPrice(assessment.routingPriceUsdPerM);
  const S = clamp01(input.effectiveTps / 200);
  const Q = assessment.quotaQuality;
  const I = assessment.intelligenceFactor;
  return (
    SCORE_WEIGHTS.P * P +
    SCORE_WEIGHTS.S * S +
    SCORE_WEIGHTS.Q * Q +
    SCORE_WEIGHTS.I * I
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
  assert.equal(ev.kind === "rejected" ? ev.reason : "", reason);
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

test("complete full-cycle weekly evidence at 28% remaining with ~84% expected remaining is strained, never unknown", () => {
  const weekly = assessRequiredQuota(NOW, [q("7d", fullCycleEv(28, 0.84))]);
  assert.equal(weekly.state, "strained");
  assert.equal(weekly.coverageComplete, true);
  assert.equal(weekly.headroomTrusted, true);
  close(
    weekly.headroom!,
    0.75 * 0.28 + 0.25 * (0.28 / 0.84),
    1e-9,
    "weekly blended H"
  );
  assert.equal(weekly.constraints[0].state, "strained");
  assert.notEqual(weekly.headroom, NEUTRAL_HEADROOM);
});

test("complete kimi-shaped evidence (rolling 5h 100% + full-cycle 7d 96%) is healthy", () => {
  const result = assessRequiredQuota(NOW, [
    q("5h", rollingEv(100)),
    q("7d", fullCycleEv(96, 1)),
  ]);
  assert.equal(result.state, "healthy");
  assert.equal(result.coverageComplete, true);
  assert.equal(result.headroomTrusted, true);
  close(result.headroom!, Math.min(1, 0.96), 1e-9, "min healthy H");
  assert.deepEqual(
    result.constraints.map((constraint) => constraint.state),
    ["healthy", "healthy"]
  );
});

test("the $10 gate still rejects unknown or incomplete coverage and sub-$10 strained stays accepted", () => {
  // Complete low-remaining weekly evidence is strained but trustworthy: $9.99 accepted.
  const strained = expectAccepted(
    cand({
      referenceUsdPerM: 9.99,
      requiredQuota: [q("7d", fullCycleEv(28, 0.84))],
    })
  );
  assert.equal(strained!.tier, "strained");
  assert.equal(strained!.coverageComplete, true);
  // Unknown coverage at $10+ stays rejected by the reference price gate.
  expectRejected(
    cand({
      referenceUsdPerM: 10,
      requiredQuota: [q("5h", rollingEv(50))],
    }),
    "reference_price_gate"
  );
  // Incomplete coverage at $10+ stays rejected even with one strained constraint.
  expectRejected(
    cand({
      referenceUsdPerM: 10,
      requiredQuota: [q("7d", fullCycleEv(28, 0.84)), q("monthly", null)],
    }),
    "reference_price_gate"
  );
  // Stale evidence keeps failing closed to incomplete unknown coverage.
  const stale = assessRequiredQuota(NOW, [
    q("5h", {
      ...rollingEv(100),
      observedAtMs: NOW - 2 * HOUR_MS,
      validForMs: HOUR_MS,
    }),
  ]);
  assert.equal(stale.state, "unknown");
  assert.equal(stale.coverageComplete, false);
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
    cand({ intelligenceRank: 99 }),
    "intelligence_out_of_range"
  );
  expectRejected(
    cand({ intelligenceMinRank: 9 }),
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
  const freeCand = cand({
    referenceUsdPerM: 0,
    referenceKind: "verified_free",
    effectiveCapUsdPerM: 0,
  });
  const free = expectAccepted(freeCand);
  close(free!.score, expScore(freeCand, free!), 1e-12, "free score");
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

test("healthy tiers compute quota metrics and normalized score exactly", () => {
  const input = cand({
    canonicalId: "healthy-a",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 20,
    requiredQuota: [q("q", fullCycleEv(60, 0.5))], // H 0.70
  });
  const a = expectAccepted(input);
  assert.equal(a!.tier, "healthy");
  assert.equal(a!.coverageComplete, true);
  assert.equal(a!.headroomTrusted, true);
  assert.equal(a!.quotaQuality, a!.headroom);
  close(a!.headroom, 0.7, 1e-9, "healthy H");
  close(a!.quotaQuality, 0.7, 1e-9, "Q without efficiency");
  assert.equal(a!.verifiedEfficiency, null);
  assert.equal(a!.marginalApplied, false);
  assert.equal(a!.routingPriceUsdPerM, 2);
  close(a!.priceFactor, interpPrice(2), 1e-12, "diagnostic P");
  close(a!.speedFactor, clamp01(25 / 200), 1e-12, "diagnostic S saturated at 200");
  close(a!.intelligenceFactor, 1, 1e-12, "I saturated");
  close(a!.score, expScore(input, a!), 1e-12, "normalized score");
});

// ---------------------------------------------------------------------------
// Approved normalized formula: weights, price anchors, speed, quota, intelligence
// ---------------------------------------------------------------------------

test("score weights sum to 1 with .50/.20/.20/.10", () => {
  assert.equal(SCORE_WEIGHTS.P, 0.5);
  assert.equal(SCORE_WEIGHTS.S, 0.2);
  assert.equal(SCORE_WEIGHTS.Q, 0.2);
  assert.equal(SCORE_WEIGHTS.I, 0.1);
  close(SCORE_WEIGHTS.P + SCORE_WEIGHTS.S + SCORE_WEIGHTS.Q + SCORE_WEIGHTS.I, 1, 1e-12);
});

test("price factor anchors interpolate continuously, monotonically, and floor at >=50", () => {
  const anchors = PRICE_FACTOR_ANCHORS;
  // Exact anchor values: 0/.5/1/2/6/30/50.
  close(interpPrice(0), 1, 1e-12, "P(0)");
  close(interpPrice(0.5), 0.85, 1e-12, "P(0.5)");
  close(interpPrice(1), 0.75, 1e-12, "P(1)");
  close(interpPrice(2), 0.6, 1e-12, "P(2)");
  close(interpPrice(6), 0.35, 1e-12, "P(6)");
  close(interpPrice(30), 0.05, 1e-12, "P(30)");
  close(interpPrice(50), 0, 1e-12, "P(50)");

  // Interpolation between anchors is continuous and strictly non-increasing.
  let prev = Number.POSITIVE_INFINITY;
  for (let p = 0; p <= 50; p += 0.1) {
    const v = interpPrice(p);
    assert.ok(v <= 1 + 1e-9 && v >= -1e-9, `P(${p}) within [0,1]`);
    if (p > 0) assert.ok(v <= prev + 1e-9, `P(${p}) monotonic non-increasing`);
    prev = v;
  }
  // Prices at or above the final anchor score 0.
  assert.equal(interpPrice(50), 0);
  assert.equal(interpPrice(1000), 0);
  // Non-positive or non-finite prices score P=1 (free/unknown).
  assert.equal(interpPrice(0), 1);
  assert.equal(interpPrice(-1), 1);
  assert.equal(interpPrice(Number.NaN), 1);
  assert.equal(interpPrice(Number.POSITIVE_INFINITY), 1);

  // The same anchors drive the assessed price factor.
  const a = expectAccepted(cand({ referenceUsdPerM: 2 }));
  close(a!.priceFactor, interpPrice(2), 1e-12, "assessed P");
  // Invalid reference price rejects the candidate rather than scoring.
  expectRejected(cand({ referenceUsdPerM: Number.NaN }), "invalid_reference_price");
  expectRejected(cand({ referenceUsdPerM: -0.01 }), "invalid_reference_price");
});

test("speed factor S is effective TPS saturated at 200", () => {
  const s = (tps: number) => clamp01(tps / 200);
  close(s(0), 0, 1e-12, "S(0)");
  close(s(100), 0.5, 1e-12, "S(100)");
  close(s(200), 1, 1e-12, "S(200)");
  close(s(1000), 1, 1e-12, "S saturated");
  const a = expectAccepted(cand({ effectiveTps: 25 }));
  close(a!.speedFactor, clamp01(25 / 200), 1e-12, "assessed S");
});

test("unknown tier uses neutral headroom 0.5 for Q; verified efficiency blends into Q only", () => {
  const unknown = expectAccepted(cand({ requiredQuota: [q("u", rollingEv(50))] }));
  assert.equal(unknown!.tier, "unknown");
  close(unknown!.headroom, NEUTRAL_HEADROOM, 1e-12, "neutral H");
  close(unknown!.quotaQuality, NEUTRAL_HEADROOM, 1e-12, "Q=neutral");
  // Efficiency blends into Q while H/tier stay neutral.
  const blended = expectAccepted(
    cand({ requiredQuota: [q("u", rollingEv(50))], verifiedEfficiency: coveredEfficiency(0.9) })
  );
  close(
    blended!.quotaQuality,
    EFFICIENCY_HEADROOM_WEIGHT * NEUTRAL_HEADROOM + EFFICIENCY_EVIDENCE_WEIGHT * 0.9,
    1e-12,
    "blended Q"
  );
  assert.equal(blended!.tier, "unknown");
});

test("intelligence factor I rewards exact expected, tiers above/below, and absent ranks 0..1/3..1", () => {
  // exact: model rank equals expected -> I=1
  const exact = expectAccepted(
    cand({ intelligenceRank: 2, intelligenceMinRank: 0, intelligenceExpectedRank: 2 })
  );
  close(exact!.intelligenceFactor, 1, 1e-12, "exact I=1");
  // one tier above expected (rank 3 vs 2): d=1 -> penalty 0.1 -> I=0.9
  const above = expectAccepted(
    cand({ intelligenceRank: 3, intelligenceMinRank: 0, intelligenceExpectedRank: 2 })
  );
  close(above!.intelligenceFactor, 0.9, 1e-12, "one above I=0.9");
  // one tier below expected (rank 1 vs 2): d=-1 -> penalty 0.25 -> I=0.75
  const below = expectAccepted(
    cand({ intelligenceRank: 1, intelligenceMinRank: 0, intelligenceExpectedRank: 2 })
  );
  close(below!.intelligenceFactor, 0.75, 1e-12, "one below I=0.75");
  // absent expected rank: I = rank/3
  for (const [rank, expectedI] of [
    [0, 0],
    [1, 1 / 3],
    [2, 2 / 3],
    [3, 1],
  ] as const) {
    const a = expectAccepted(
      cand({ intelligenceRank: rank, intelligenceMinRank: 0 })
    );
    close(a!.intelligenceFactor, expectedI, 1e-12, `absent I rank ${rank}`);
  }
});

test("intelligenceExpectedRank below the minimum or non-integer is rejected", () => {
  expectRejected(
    cand({ intelligenceRank: 2, intelligenceMinRank: 0, intelligenceExpectedRank: 5 }),
    "invalid_intelligence"
  );
  expectRejected(
    cand({ intelligenceRank: 2, intelligenceMinRank: 0, intelligenceExpectedRank: -1 }),
    "invalid_intelligence"
  );
  expectRejected(
    cand({ intelligenceRank: 2, intelligenceMinRank: 0, intelligenceExpectedRank: 1.5 }),
    "invalid_intelligence"
  );
  // An expected rank above the old ceiling stays admissible: there is no
  // configurable maximum intelligence band.
  const premium = expectAccepted(
    cand({ intelligenceRank: 3, intelligenceMinRank: 2, intelligenceExpectedRank: 3 })
  );
  close(premium!.intelligenceFactor, 1, 1e-12, "premium above old high ceiling");
});

test("minimum TPS gate rejects regardless of other strengths", () => {
  // Strong price, quota, and intelligence cannot outweigh a speed deficit.
  expectRejected(
    cand({ minimumTps: 100, effectiveTps: 50, referenceUsdPerM: 0, referenceKind: "verified_free" }),
    "speed_below_minimum"
  );
  const accepted = expectAccepted(
    cand({ minimumTps: 5, effectiveTps: 5, referenceUsdPerM: 0, referenceKind: "verified_free" })
  );
  close(accepted!.speedFactor, clamp01(5 / 200), 1e-12, "min met S");
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
  close(withMargin!.priceFactor, interpPrice(4), 1e-12, "P on marginal");
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

test("a marginal discount only feeds the normalized score; Q advantage can outweigh a small P premium", () => {
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
  // Baseline P(2)=0.6, Q=0.25; discounted P(2.9)=0.54375, Q=0.70. The Q
  // advantage (0.70 vs 0.25, weighted 0.2 => +0.09) outweighs the P premium
  // (weighted 0.5 => -0.028), so the discounted candidate ranks first.
  assert.deepEqual(rankedIds(result), ["marg-3", "cheap-2"]);
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

test("valid efficiency changes Q only; H/tier/diagnostics unchanged", () => {
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

test("verified efficiency lifts Q only; its score contribution can outweigh an economic gap", () => {
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
    requiredQuota: [q("q", fullCycleEv(60, 0.3))], // H 0.70
    verifiedEfficiency: coveredEfficiency(0.9), // Q -> 0.73
  });
  const h = expectAccepted(highEff);
  close(h!.quotaQuality, 0.85 * 0.7 + 0.15 * 0.9, 1e-12, "boosted Q");
  // The Q boost (0.73 vs 0.25, weighted 0.2 => +0.096) outweighs the P gap
  // (P(4)=0.475 vs P(2)=0.6, weighted 0.5 => -0.0625), so the higher-efficiency
  // candidate leads on the normalized score.
  const result = rankAutoRoutingCandidates([baseline, highEff]);
  assert.deepEqual(rankedIds(result), ["eff-strong", "cheap-eff"]);
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
// Approved normalized ranking: single global deterministic score order
// ---------------------------------------------------------------------------

test("global ranking is one deterministic descending score order", () => {
  const c1 = cand({ canonicalId: "c1", referenceUsdPerM: 6, requiredQuota: [q("q", hQ(0.5))] });
  const c2 = cand({ canonicalId: "c2", referenceUsdPerM: 1, requiredQuota: [q("q", hQ(0.8))] });
  const c3 = cand({ canonicalId: "c3", referenceUsdPerM: 30, requiredQuota: [q("q", hQ(0.95))] });
  // c1: P(6)=0.35, Q0.5  -> 0.175 + 0.025 + 0.1 + 0.1 = 0.40
  // c2: P(1)=0.75, Q0.8  -> 0.375 + 0.025 + 0.16 + 0.1 = 0.66
  // c3: P(30)=0.05, Q0.95 -> 0.025 + 0.025 + 0.19 + 0.1 = 0.34
  const forward = rankAutoRoutingCandidates([c1, c2, c3]);
  const reversed = rankAutoRoutingCandidates([c3, c2, c1]);
  assert.deepEqual(rankedIds(forward), ["c2", "c1", "c3"]);
  assert.deepEqual(rankedIds(reversed), ["c2", "c1", "c3"]);
});

test("DS prices 1.2 vs 0.6 produce a score delta of 0.055 with other inputs equal", () => {
  const a = cand({ canonicalId: "ds-1.2", referenceUsdPerM: 1.2 });
  const b = cand({ canonicalId: "ds-0.6", referenceUsdPerM: 0.6 });
  const [ea, eb] = [a, b].map((x) => expectAccepted(x)!);
  // P(1.2)=0.72, P(0.6)=0.83 -> delta P 0.11, weighted by P=0.5 -> 0.055
  close(ea.priceFactor, interpPrice(1.2), 1e-12, "P(1.2)");
  close(eb.priceFactor, interpPrice(0.6), 1e-12, "P(0.6)");
  close(eb.score - ea.score, 0.055, 1e-9, "delta 0.055");
});

test("quota tiers can cross by score while blocked remains rejected", () => {
  // A healthy candidate with a low score can rank below an unknown candidate
  // with a higher score: tier is no longer an outer sort key.
  const healthyLow = cand({
    canonicalId: "healthy-low",
    referenceUsdPerM: 30, // P(30)=0.05
    requiredQuota: [q("q", hQ(0.9))], // Q 0.90
  });
  const unknownHigh = cand({
    canonicalId: "unknown-high",
    referenceUsdPerM: 0.5, // P(0.5)=0.85
    requiredQuota: [q("u", rollingEv(50))], // Q = neutral 0.5
  });
  const blocked = cand({
    canonicalId: "blocked-x",
    requiredQuota: [q("z", rollingEv(0))],
  });
  const result = rankAutoRoutingCandidates([healthyLow, unknownHigh, blocked]);
  // unknown-high (P 0.85, Q 0.5 => 0.65) beats healthy-low (P 0.05, Q 0.9 => 0.33)
  assert.deepEqual(rankedIds(result), ["unknown-high", "healthy-low"]);
  assert.deepEqual(
    result.excluded.map((entry) => [entry.canonicalId, entry.reason]),
    [["blocked-x", "quota_blocked"]]
  );
});

test("verified-free changes routing price/P only and has no priority bucket", () => {
  // A confirmed-free candidate routes for free (P=1) but is still ranked by its
  // overall score; a higher-scoring standard candidate outranks it, proving
  // there is no free-supply priority bucket.
  const free = cand({
    canonicalId: "free-a",
    requiredQuota: [q("rolling", rollingEv(50))], // unknown -> Q 0.5
    confirmedFreeSupply: confirmedFreeSupply(),
  });
  const standard = cand({
    canonicalId: "std-a",
    referenceUsdPerM: 0, // verified_free reference also P=1
    referenceKind: "verified_free",
    requiredQuota: [q("q", fullCycleEv(80, 1))], // healthy -> Q 0.8
  });
  const [f, s] = [free, standard].map((x) => expectAccepted(x)!);
  assert.equal(f.supplyClass, "confirmed_free");
  assert.equal(s.supplyClass, "standard");
  assert.equal(f.routingPriceUsdPerM, 0);
  assert.equal(f.priceFactor, 1);
  assert.equal(s.routingPriceUsdPerM, 0);
  assert.equal(s.priceFactor, 1);
  assert.ok(s.score > f.score, "standard outranks free by score, not priority");
    const result = rankAutoRoutingCandidates([free, standard]);
    assert.deepEqual(rankedIds(result), ["std-a", "free-a"]);
  })

test("expected premium ranks the eligible premium candidate above a cheaper faster high", () => {
  const premium = cand({
    canonicalId: "premium-cand",
    referenceUsdPerM: 30,
    effectiveCapUsdPerM: 40,
    intelligenceRank: 3,
    intelligenceMinRank: 0,
    intelligenceExpectedRank: 3,
  })
  const high = cand({
    canonicalId: "high-cand",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    effectiveTps: 200,
    intelligenceRank: 2,
    intelligenceMinRank: 0,
    intelligenceExpectedRank: 3,
  })
  const result = rankAutoRoutingCandidates([high, premium])
  assert.deepEqual(rankedIds(result), ["premium-cand", "high-cand"])
  assert.equal(result.ranked[0].intelligenceShortfall, 0)
  assert.equal(result.ranked[1].intelligenceShortfall, 1)
})

test("expected premium falls back to the eligible high when premium is blocked by a hard gate", () => {
  const premiumBlocked = cand({
    canonicalId: "premium-blocked",
    intelligenceRank: 3,
    intelligenceMinRank: 0,
    intelligenceExpectedRank: 3,
    requiredQuota: [q("z", rollingEv(0))],
  })
  const high = cand({
    canonicalId: "high-ok",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    intelligenceRank: 2,
    intelligenceMinRank: 0,
    intelligenceExpectedRank: 3,
  })
  const result = rankAutoRoutingCandidates([high, premiumBlocked])
  assert.deepEqual(rankedIds(result), ["high-ok"])
  assert.deepEqual(result.excluded.map((entry) => entry.canonicalId), ["premium-blocked"])
})

test("intelligenceMin high excludes a mid candidate and keeps the eligible high", () => {
  const mid = cand({
    canonicalId: "mid-excluded",
    intelligenceRank: 1,
    intelligenceMinRank: 2,
    intelligenceExpectedRank: 3,
  })
  const high = cand({
    canonicalId: "high-ok",
    intelligenceRank: 2,
    intelligenceMinRank: 2,
    intelligenceExpectedRank: 3,
  })
  const result = rankAutoRoutingCandidates([mid, high])
  assert.deepEqual(rankedIds(result), ["high-ok"])
  assert.equal(
    result.excluded.find((entry) => entry.canonicalId === "mid-excluded")?.reason,
    "intelligence_out_of_range"
  )
})

test("same expectation keeps the score tie-break and deterministic canon order", () => {
  const cheaper = cand({
    canonicalId: "cheaper",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    intelligenceRank: 1,
    intelligenceMinRank: 0,
    intelligenceExpectedRank: 1,
  })
  const pricier = cand({
    canonicalId: "pricier",
    referenceUsdPerM: 6,
    effectiveCapUsdPerM: 10,
    intelligenceRank: 1,
    intelligenceMinRank: 0,
    intelligenceExpectedRank: 1,
  })
  const result = rankAutoRoutingCandidates([pricier, cheaper])
  assert.deepEqual(rankedIds(result), ["cheaper", "pricier"])
  assert.deepEqual(result.ranked.map((entry) => entry.intelligenceShortfall), [0, 0])
})

test("absent expected rank yields zero shortfall and preserves score ordering", () => {
  const c1 = cand({ canonicalId: "c1", referenceUsdPerM: 6, effectiveCapUsdPerM: 10 })
  const c2 = cand({ canonicalId: "c2", referenceUsdPerM: 1, effectiveCapUsdPerM: 10 })
  const result = rankAutoRoutingCandidates([c1, c2])
  assert.deepEqual(rankedIds(result), ["c2", "c1"])
  assert.deepEqual(result.ranked.map((entry) => entry.intelligenceShortfall), [0, 0])
})

test("selected candidate below expected surfaces an intelligence_below_expected note", () => {
  const premiumBlocked = cand({
    canonicalId: "premium-blocked",
    intelligenceRank: 3,
    intelligenceMinRank: 0,
    intelligenceExpectedRank: 3,
    requiredQuota: [q("z", rollingEv(0))],
  })
  const high = cand({
    canonicalId: "high",
    referenceUsdPerM: 1,
    effectiveCapUsdPerM: 10,
    intelligenceRank: 2,
    intelligenceMinRank: 0,
    intelligenceExpectedRank: 3,
  })
  const result = rankAutoRoutingCandidates([high, premiumBlocked])
  assert.deepEqual(rankedIds(result), ["high"])
  assert.equal(result.ranked[0].intelligenceShortfall, 1)
  assert.ok(result.ranked[0].notes.includes("intelligence_below_expected"))
});

test("all factors and the score stay within [0,1]", () => {
  // High price requires healthy quota to pass the independent safety gate.
  const worst = expectAccepted(
    cand({
      canonicalId: "worst",
      referenceUsdPerM: 1000,
      effectiveCapUsdPerM: 2000,
      minimumTps: 0,
      effectiveTps: 0,
      intelligenceRank: 0,
      intelligenceMinRank: 0,
      requiredQuota: [q("u", fullCycleEv(90, 1))],
    })
  )!;
  // P(1000)=0, S(0)=0, I=0; only the admitted quota contributes.
  for (const factor of [worst.priceFactor, worst.speedFactor, worst.quotaQuality, worst.intelligenceFactor, worst.score]) {
    assert.ok(factor >= 0 && factor <= 1, `worst factor ${factor} within [0,1]`);
  }
  close(worst.score, 0.2 * worst.quotaQuality, 1e-12, "worst score = 0.2*Q");

  // Best case: free price, max speed, healthy quota, top intelligence.
  const best = expectAccepted(
    cand({
      canonicalId: "best",
      referenceUsdPerM: 0,
      referenceKind: "verified_free",
      effectiveTps: 1000,
      intelligenceRank: 3,
      requiredQuota: [q("q", rollingEv(100))],
    })
  )!;
  for (const factor of [best.priceFactor, best.speedFactor, best.quotaQuality, best.intelligenceFactor, best.score]) {
    assert.ok(factor >= 0 && factor <= 1, `best factor ${factor} within [0,1]`);
  }
  close(best.score, 1, 1e-12, "best score = 1");
});

test("reference cap still rejects an arbitrarily fast candidate", () => {
  const hypersonic = cand({
    canonicalId: "hypersonic",
    referenceUsdPerM: 9,
    effectiveCapUsdPerM: 6,
    effectiveTps: 10_000,
    requiredQuota: [q("q", hQ(0.9))],
  });
  expectRejected(hypersonic, "reference_above_cap");
});

test("missing, NaN, or infinite speed never creates a bonus and stays rejected", () => {
  expectRejected(cand({ effectiveTps: Number.NaN }), "invalid_speed");
  expectRejected(cand({ effectiveTps: Number.POSITIVE_INFINITY }), "invalid_speed");
  expectRejected(
    cand({ effectiveTps: Number.NEGATIVE_INFINITY }),
    "invalid_speed"
  );
  expectRejected(
    cand({ effectiveTps: undefined as unknown as number }),
    "invalid_speed"
  );
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
    marginalPrice: coveredMarginal(1.5), // discount below the $2 reference (1.5 < 2) applies
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
