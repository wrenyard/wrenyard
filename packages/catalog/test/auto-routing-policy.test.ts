/**
 * Focused node:test coverage for packages/catalog/src/auto-routing-policy.ts.
 *
 * Covers the pure two-file (source + test) contract: quota evidence
 * semantics, full-cycle/rolling aggregation, hard guards, marginal price and
 * verified quota-burn efficiency economic evidence, and the approved normalized
 * ranking score:
 *   score = .40*P + .30*S + .20*Q + .10*I
 * where P is the continuous price-factor from fixed anchors,
 * S = min(TPS / (SPEED_SATURATION_BASE_TPS + expectedTps), 1),
 * Q is quota headroom quality, and I is the intelligence factor. Every factor is
 * bounded in [0, 1], so the score is always within [0, 1]. Ranking is one global
 * deterministic descending-score pass; supply class and quota tier are retained
 * only as diagnostic fields and never as sort keys.
 *
 * Note: ranking fixtures use synthetic labels ("ds-flash-like",
 * "glm-flash-like") purely to make canonical/snapshot ids readable. No real
 * provider pricing or quota is asserted anywhere.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_WEIGHTS,
  PRICE_FACTOR_ANCHORS,
  SPEED_SATURATION_BASE_TPS,
  ZERO_QUOTA_HEADROOM,
  UNKNOWN_QUOTA_FLOOR_HEADROOM,
  EFFICIENCY_HEADROOM_WEIGHT,
  EFFICIENCY_EVIDENCE_WEIGHT,
  assessRequiredQuota,
  evaluateCandidate,
  rankAutoRoutingCandidates,
  validateScoreWeights,
  type ScoreWeights,
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
// continuous anchor-interpolated price factor; S saturates effective TPS at
// SPEED_SATURATION_BASE_TPS plus the candidate's expected TPS (absent = 0).
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
  assessment: CandidateAssessment,
  weights: ScoreWeights = SCORE_WEIGHTS
): number {
  const P = interpPrice(assessment.routingPriceUsdPerM);
  const expectedTps = input.expectedTps;
  const saturation =
    SPEED_SATURATION_BASE_TPS +
    (typeof expectedTps === "number" && Number.isFinite(expectedTps) ? expectedTps : 0);
  const S = clamp01(input.effectiveTps / saturation);
  // Mirrors the policy's Q input: the raw headroom H, raised to the
  // provider-verified unknown-quota floor when that floor applies.
  const floorApplied = input.unknownQuotaFloor != null && assessment.unknownQuotaFloorApplied;
  const Q =
    !floorApplied || assessment.verifiedEfficiency !== null
      ? assessment.quotaQuality
      : clamp01(Math.max(assessment.headroom, UNKNOWN_QUOTA_FLOOR_HEADROOM));
  const I = assessment.intelligenceFactor;
  return (
    weights.P * P +
    weights.S * S +
    weights.Q * Q +
    weights.I * I
  );
}

function rankedIds(result: { ranked: { canonicalId: string }[] }): string[] {
  return result.ranked.map((r) => r.canonicalId);
}

function expectAccepted(c: CandidateInput, weights?: ScoreWeights) {
  const ev = evaluateCandidate(c, weights);
  assert.equal(ev.kind, "accepted", `expected acceptance for ${c.canonicalId}`);
  return ev.kind === "accepted" ? ev.assessment : null;
}

function expectRejected(c: CandidateInput, reason: string, weights?: ScoreWeights) {
  const ev = evaluateCandidate(c, weights);
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
  assert.equal(unknownMid.headroom, ZERO_QUOTA_HEADROOM);

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
  assert.equal(single.headroom, ZERO_QUOTA_HEADROOM);

  const withMissing = assessRequiredQuota(NOW, [
    q("u", unknownEv),
    q("monthly", null),
  ]);
  assert.equal(withMissing.state, "unknown");
  assert.equal(withMissing.coverageComplete, false);
  assert.equal(withMissing.headroom, ZERO_QUOTA_HEADROOM);
  assert.equal(withMissing.constraints[1].state, "missing");
});

test("empty required quota is unknown with incomplete coverage", () => {
  const empty = assessRequiredQuota(NOW, []);
  assert.equal(empty.state, "unknown");
  assert.equal(empty.coverageComplete, false);
  assert.equal(empty.headroomTrusted, false);
  assert.equal(empty.headroom, ZERO_QUOTA_HEADROOM);
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

test("equal arithmetic mean is taken across joint healthy full-cycle constraints", () => {
  // Each constraint is one pool resource and participates equally:
  // (0.90 + 0.70 + 0.85) / 3 = 0.816666...
  const joint = assessRequiredQuota(NOW, [
    q("wide", fullCycleEv(90, 1)),
    q("tight", fullCycleEv(60, 0.3)),
    q("mid", fullCycleEv(85, 1)),
  ]);
  assert.equal(joint.state, "healthy");
  assert.equal(joint.coverageComplete, true);
  assert.equal(joint.headroomTrusted, true);
  close(joint.headroom!, (0.9 + 0.7 + 0.85) / 3, 1e-9, "mean across healthy headrooms");
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
  assert.notEqual(weekly.headroom, ZERO_QUOTA_HEADROOM);
});

test("complete kimi-shaped evidence (rolling 5h 100% + full-cycle 7d 96%) is healthy", () => {
  const result = assessRequiredQuota(NOW, [
    q("5h", rollingEv(100)),
    q("7d", fullCycleEv(96, 1)),
  ]);
  assert.equal(result.state, "healthy");
  assert.equal(result.coverageComplete, true);
  assert.equal(result.headroomTrusted, true);
  close(result.headroom!, (1 + 0.96) / 2, 1e-9, "mean healthy H");
  assert.deepEqual(
    result.constraints.map((constraint) => constraint.state),
    ["healthy", "healthy"]
  );
});

test("unknown quota scores zero regardless of listed price and sub-price strained stays accepted", () => {
  // Complete low-remaining weekly evidence is strained but trustworthy: $9.99 accepted.
  const strained = expectAccepted(
    cand({
      referenceUsdPerM: 9.99,
      requiredQuota: [q("7d", fullCycleEv(28, 0.84))],
    })
  );
  assert.equal(strained!.tier, "strained");
  assert.equal(strained!.coverageComplete, true);
  // Unknown quota stays eligible: no listed reference price can turn a genuinely
  // unknown/incomplete quota into a price rejection.
  const unknownHigh = expectAccepted(
    cand({
      referenceUsdPerM: 10,
      requiredQuota: [q("5h", rollingEv(50))],
    })
  );
  assert.equal(unknownHigh!.tier, "unknown");
  // Incomplete coverage plus a strained constraint is likewise never gated by price.
  const incompleteStrained = expectAccepted(
    cand({
      referenceUsdPerM: 10,
      requiredQuota: [q("7d", fullCycleEv(28, 0.84)), q("monthly", null)],
    })
  );
  assert.equal(incompleteStrained!.tier, "strained");
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

test("strained + missing averages in the zero unknown contribution", () => {
  const result = assessRequiredQuota(NOW, [
    q("strain", rollingEv(4)),
    q("monthly", null),
  ]);
  assert.equal(result.state, "strained");
  assert.equal(result.coverageComplete, false);
  assert.equal(result.headroomTrusted, false);
  close(result.headroom!, (0.04 + ZERO_QUOTA_HEADROOM) / 2, 1e-12, "strained + missing mean H");
});

test("strained + unknown averages in the zero unknown contribution", () => {
  const result = assessRequiredQuota(NOW, [
    q("strain", rollingEv(4)),
    q("unknown", rollingEv(50)),
  ]);
  assert.equal(result.state, "strained");
  assert.equal(result.coverageComplete, true);
  assert.equal(result.headroomTrusted, false);
  close(result.headroom!, (0.04 + ZERO_QUOTA_HEADROOM) / 2, 1e-12, "strained + unknown mean H");
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

test("cap zero admits only effective zero price", () => {
  const freeCand = cand({
    referenceUsdPerM: 0,
    effectiveCapUsdPerM: 0,
  });
  const free = expectAccepted(freeCand);
  close(free!.score, expScore(freeCand, free!), 1e-12, "free score");
  // Anything above a zero cap is above-cap, and a positive price under zero
  // cap is impossible since reference > cap rejects first.
  expectRejected(
    cand({ referenceUsdPerM: 0.01, effectiveCapUsdPerM: 0 }),
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
// Equal arithmetic-mean aggregation of required quota constraints
// ---------------------------------------------------------------------------

test("two healthy constraints average equally: 0.8 and 1.0 mean to 0.9", () => {
  const result = assessRequiredQuota(NOW, [
    q("a", rollingEv(80)),
    q("b", rollingEv(100)),
  ]);
  assert.equal(result.state, "healthy");
  assert.equal(result.coverageComplete, true);
  assert.equal(result.headroomTrusted, true);
  close(result.headroom!, 0.9, 1e-12, "mean of 0.8 and 1.0");
  close(result.constraints[0].headroom!, 0.8, 1e-12, "constraint a H");
  close(result.constraints[1].headroom!, 1, 1e-12, "constraint b H");
});

test("three constraints average equally regardless of order", () => {
  const expected = (0.9 + 0.04 + ZERO_QUOTA_HEADROOM) / 3;
  const forward = assessRequiredQuota(NOW, [
    q("h", rollingEv(90)),
    q("s", rollingEv(4)),
    q("u", rollingEv(50)),
  ]);
  const reversed = assessRequiredQuota(NOW, [
    q("u", rollingEv(50)),
    q("s", rollingEv(4)),
    q("h", rollingEv(90)),
  ]);
  assert.equal(forward.state, "strained");
  assert.equal(reversed.state, "strained");
  close(forward.headroom!, expected, 1e-12, "forward 3-way mean");
  close(reversed.headroom!, expected, 1e-12, "reversed 3-way mean");
});

test("unknown 0 contributes nothing without discarding a healthy peer", () => {
  const result = assessRequiredQuota(NOW, [
    q("h", rollingEv(80)),
    q("u", rollingEv(50)),
  ]);
  assert.equal(result.state, "unknown");
  assert.equal(result.coverageComplete, true);
  assert.equal(result.headroomTrusted, false);
  // Equal mixed pool: (0.8 + 0) / 2 === 0.4 exactly.
  assert.equal(result.headroom, 0.4);
});

test("positive balance contributes zero 0 alongside a healthy peer", () => {
  const result = assessRequiredQuota(NOW, [
    q("q", rollingEv(80)),
    {
      id: "deepseek-balance",
      evidence: null,
      kind: "balance",
      balance: { amount: "12.50", observedAtMs: NOW - 1_000, validForMs: HOUR_MS },
    },
  ]);
  assert.equal(result.state, "healthy");
  assert.equal(result.coverageComplete, true);
  // Equal mixed pool: (0.8 + 0) / 2 === 0.4 exactly.
  assert.equal(result.headroom, 0.4);
});

test("any exhausted (zero) constraint rejects the candidate even alongside a healthy peer", () => {
  const blocked = expectRejected(
    cand({ requiredQuota: [q("z", rollingEv(0)), q("h", rollingEv(90))] }),
    "quota_blocked"
  );
  assert.ok(blocked!.detail!.includes("z"));
  const pool = assessRequiredQuota(NOW, [q("z", rollingEv(0)), q("h", rollingEv(90))]);
  assert.equal(pool.state, "blocked");
  assert.equal(pool.headroom, null);
  assert.deepEqual(pool.blockedConstraintIds, ["z"]);
});

// ---------------------------------------------------------------------------
// Editable score weights: validated custom sets drive ranking
// ---------------------------------------------------------------------------

describe("editable score weights", () => {
  const PRICE_ONLY: ScoreWeights = { P: 1, S: 0, Q: 0, I: 0 };
  const SPEED_ONLY: ScoreWeights = { P: 0, S: 1, Q: 0, I: 0 };
  // Equal quota/quality/intelligence; only P and S differ, and the cheap-but-
  // slow candidate P-outranks the fast-but-expensive one while the fast one
  // S-outranks the cheap one.
  const cheapSlow = () => cand({
    snapshotId: "rank",
    canonicalId: "cheap-slow",
    referenceUsdPerM: 0.5,
    effectiveCapUsdPerM: 10,
    effectiveTps: 10,
    requiredQuota: [q("q", fullCycleEv(80, 1))],
  });
  const fastPricey = () => cand({
    snapshotId: "rank",
    canonicalId: "fast-pricey",
    referenceUsdPerM: 30,
    effectiveCapUsdPerM: 40,
    effectiveTps: 200,
    requiredQuota: [q("q", fullCycleEv(80, 1))],
  });

  test("custom weights reverse the chosen rank relative to the defaults", () => {
    const inputs = [cheapSlow(), fastPricey()];
    const [cs, fp] = inputs.map((input) => expectAccepted(input)!);
    close(cs.priceFactor, 0.85, 1e-12, "cheap P(0.5)");
    close(cs.speedFactor, 0.1, 1e-12, "cheap S");
    close(fp.priceFactor, 0.05, 1e-12, "pricey P(30)");
    close(fp.speedFactor, 1, 1e-12, "pricey S");

    // Defaults (.4/.3/.2/.1) weight price more heavily than speed, so the
    // cheap-but-slow candidate wins.
    const byDefault = rankAutoRoutingCandidates(inputs);
    assert.deepEqual(rankedIds(byDefault), ["cheap-slow", "fast-pricey"]);
    assert.deepEqual(byDefault.ranked[0].weights, SCORE_WEIGHTS);

    // A price-only weight set keeps the same winner.
    assert.deepEqual(
      rankedIds(rankAutoRoutingCandidates(inputs, PRICE_ONLY)),
      ["cheap-slow", "fast-pricey"]
    );
    // A speed-only weight set reverses the order: the fast candidate leads.
    assert.deepEqual(
      rankedIds(rankAutoRoutingCandidates(inputs, SPEED_ONLY)),
      ["fast-pricey", "cheap-slow"]
    );
    // Each ranked position carries the exact weight set used.
    assert.deepEqual(rankAutoRoutingCandidates(inputs, SPEED_ONLY).ranked[0].weights, SPEED_ONLY);
  });

  test("custom weights score equals the weighted sum of the same factors", () => {
    const input = cheapSlow();
    const custom: ScoreWeights = { P: 0.25, S: 0.25, Q: 0.25, I: 0.25 };
    const withCustom = expectAccepted(input, custom)!;
    close(withCustom.score, expScore(input, withCustom, custom), 1e-12, "custom score");
    assert.deepEqual(withCustom.weights, custom);
  });

  test("validateScoreWeights rejects missing and extra keys", () => {
    assert.throws(() => validateScoreWeights({ P: 0.4, S: 0.3, Q: 0.2 }), /missing required key I/);
    assert.throws(
      () => validateScoreWeights({ P: 0.4, S: 0.3, Q: 0.2, I: 0.1, X: 0 }),
      /unknown key X/
    );
    assert.throws(() => validateScoreWeights({ P: 0.4, S: 0.3, Q: 0.2, I: 0.1, price: 0 }), /unknown key price/);
  });

  test("validateScoreWeights rejects non-finite, negative, out-of-range, and non-1 sums", () => {
    assert.throws(() => validateScoreWeights({ P: Number.NaN, S: 0.3, Q: 0.2, I: 0.1 }), /finite number/);
    assert.throws(
      () => validateScoreWeights({ P: Number.POSITIVE_INFINITY, S: 0.3, Q: 0.2, I: 0.1 }),
      /finite number/
    );
    assert.throws(() => validateScoreWeights({ P: -0.1, S: 0.3, Q: 0.2, I: 0.6 }), /within \[0, 1\]/);
    assert.throws(() => validateScoreWeights({ P: 1.5, S: 0.3, Q: 0.2, I: 0.1 }), /within \[0, 1\]/);
    assert.throws(() => validateScoreWeights({ P: 0.5, S: 0.5, Q: 0.5, I: 0.5 }), /sum to 1/);
    assert.throws(() => validateScoreWeights({ P: 0.4, S: 0.3, Q: 0.2, I: 0.2 }), /sum to 1/);
    assert.throws(() => validateScoreWeights(null), /expected an object/);
    assert.throws(() => validateScoreWeights([0.4, 0.3, 0.2, 0.1]), /expected an object/);
  });

  test("validateScoreWeights accepts a valid complete set and returns a fresh object", () => {
    const raw = { P: 0.4, S: 0.3, Q: 0.2, I: 0.1 };
    const validated = validateScoreWeights(raw);
    assert.deepEqual(validated, raw);
    assert.notEqual(validated, raw);
    raw.P = 0.9;
    assert.equal(validated.P, 0.4, "validated copy is isolated from later mutation");
  });

  test("snapshot weights are immutable: caller mutation cannot change a ranked result", () => {
    const weights: ScoreWeights = { P: 0.4, S: 0.3, Q: 0.2, I: 0.1 };
    const inputs = [cheapSlow(), fastPricey()];
    const first = rankAutoRoutingCandidates(inputs, weights);
    const firstJson = JSON.stringify(first);
    const firstWeights = { ...first.ranked[0].weights };
    weights.P = 1;
    weights.S = 0;
    weights.Q = 0;
    weights.I = 0;
    // The earlier result is a defensive snapshot of the validated weight set.
    assert.equal(JSON.stringify(first), firstJson);
    assert.deepEqual(first.ranked[0].weights, firstWeights);
    // A fresh call re-snapshots the mutated weights and ranks accordingly.
    const second = rankAutoRoutingCandidates(inputs, weights);
    assert.deepEqual(rankedIds(second), ["cheap-slow", "fast-pricey"]);
    assert.deepEqual(second.ranked[0].weights, { P: 1, S: 0, Q: 0, I: 0 });
  });

  test("invalid custom weights throw instead of silently falling back to defaults", () => {
    const input = cheapSlow();
    assert.throws(
      () => evaluateCandidate(input, { P: 0.5, S: 0.5, Q: 0.5, I: 0.5 }),
      /sum to 1/
    );
    assert.throws(() => evaluateCandidate(input, { P: 1, S: 0, Q: 0, I: Number.NaN }), /finite number/);
    assert.throws(() => rankAutoRoutingCandidates([input], { P: 0.4, S: 0.3, Q: 0.2, I: 0.2 }), /sum to 1/);
    assert.throws(
      () => rankAutoRoutingCandidates([input], { P: 1.2, S: -0.2, Q: 0, I: 0 }),
      /within \[0, 1\]/
    );
  });
});

// ---------------------------------------------------------------------------
// Tier, gate, and incomplete-strained behavior on evaluateCandidate
// ---------------------------------------------------------------------------

test("incomplete-strained reference is accepted at any listed price", () => {
  const incompleteStrained = {
    requiredQuota: [q("strain", rollingEv(4)), q("monthly", null)],
  };
  const accepted = expectAccepted(cand({ ...incompleteStrained, referenceUsdPerM: 9.99 }));
  assert.equal(accepted!.tier, "strained");
  assert.equal(accepted!.coverageComplete, false);
  assert.equal(accepted!.headroomTrusted, false);
  close(accepted!.headroom, (0.04 + ZERO_QUOTA_HEADROOM) / 2, 1e-12, "incomplete-strained H");

  // An unknown/incomplete quota is not price-gated: a high listed reference
  // price no longer rejects it.
  const highPrice = expectAccepted(
    cand({ ...incompleteStrained, referenceUsdPerM: 10 })
  );
  assert.equal(highPrice!.tier, "strained");
});

test("unknown tier with a high reference price is accepted, not price-gated", () => {
  const unknownCovered = { requiredQuota: [q("u", rollingEv(50))] };
  const ok = expectAccepted(cand({ ...unknownCovered, referenceUsdPerM: 9.99 }));
  assert.equal(ok!.tier, "unknown");
  const high = expectAccepted(cand({ ...unknownCovered, referenceUsdPerM: 10 }));
  assert.equal(high!.tier, "unknown");
  const higher = expectAccepted(cand({ ...unknownCovered, referenceUsdPerM: 10.000001 }));
  assert.equal(higher!.tier, "unknown");
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
  close(a!.speedFactor, clamp01(25 / SPEED_SATURATION_BASE_TPS), 1e-12, "diagnostic S saturated at the bare base with no expectation");
  close(a!.intelligenceFactor, 1, 1e-12, "I saturated");
  close(a!.score, expScore(input, a!), 1e-12, "normalized score");
});

test("balance constraint: positive amount is available with zero headroom, zero blocks, unknown never fabricates zero", () => {
  const at = NOW;
  const balance = (amount: string | null) => ({
    id: "deepseek-balance",
    evidence: null,
    kind: "balance" as const,
    balance:
      amount === null
        ? null
        : { amount, observedAtMs: at - 1_000, validForMs: HOUR_MS },
  });

  // Positive valid amount: not exhausted, but no quota headroom is granted.
  const positive = assessRequiredQuota(NOW, [balance("12.50")]);
  assert.equal(positive.state, "healthy");
  assert.equal(positive.coverageComplete, true);
  assert.equal(positive.headroom, ZERO_QUOTA_HEADROOM);

  // Exactly zero blocks.
  const zero = assessRequiredQuota(NOW, [balance("0")]);
  assert.equal(zero.state, "blocked");
  assert.deepEqual(zero.blockedConstraintIds, ["deepseek-balance"]);

  // Missing / malformed / negative / stale / future are unknown, never zero-valued
  // headroom: they stay unknown and never block.
  for (const unknown of [balance(null), balance(""), balance("not-a-number"), balance("-1"), balance("0x00"), balance("0e0")]) {
    const result = assessRequiredQuota(NOW, [unknown]);
    assert.notEqual(result.state, "blocked", "unknown balance must never block");
    assert.equal(result.state, "unknown");
    assert.equal(result.headroom, ZERO_QUOTA_HEADROOM);
  }
  const stale: RequiredQuotaConstraint = {
    id: "deepseek-balance",
    evidence: null,
    kind: "balance",
    balance: { amount: "5", observedAtMs: NOW - 2 * HOUR_MS, validForMs: HOUR_MS },
  };
  assert.equal(assessRequiredQuota(NOW, [stale]).state, "unknown");

  // A positive balance keeps the candidate available; a zero balance blocks it.
  const available = expectAccepted(cand({ requiredQuota: [balance("1.00")] }));
  assert.equal(available!.tier, "healthy");
  assert.equal(available!.headroom, ZERO_QUOTA_HEADROOM);
  expectRejected(cand({ requiredQuota: [balance("0")] }), "quota_blocked");
});

test(">= 10 unknown quota is no longer blocked by any reference price gate", () => {
  for (const price of [10, 25, 100, 1000]) {
    const accepted = expectAccepted(
      cand({ referenceUsdPerM: price, effectiveCapUsdPerM: 1000, requiredQuota: [q("u", rollingEv(50))] })
    );
    assert.equal(accepted!.tier, "unknown");
  }
});



// ---------------------------------------------------------------------------
// Approved normalized formula: weights, price anchors, speed, quota, intelligence
// ---------------------------------------------------------------------------

test("score weights sum to 1 with .40/.30/.20/.10", () => {
  assert.equal(SCORE_WEIGHTS.P, 0.4);
  assert.equal(SCORE_WEIGHTS.S, 0.3);
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

test("speed factor S saturates at SPEED_SATURATION_BASE_TPS plus the expected TPS", () => {
  const s = (tps: number, expected = 0) => clamp01(tps / (SPEED_SATURATION_BASE_TPS + expected));
  // No declared expectation: the bare base is the ceiling.
  close(s(0), 0, 1e-12, "S(0)");
  close(s(50), 0.5, 1e-12, "S(50)");
  close(s(100), 1, 1e-12, "S(100)");
  close(s(1000), 1, 1e-12, "S saturated");
  // Declaring an expectation lifts the ceiling by exactly that amount.
  close(s(200, 200), 200 / 300, 1e-12, "S(200) expecting 200");
  close(s(300, 200), 1, 1e-12, "S saturates at base + expected");
  const a = expectAccepted(cand({ effectiveTps: 25 }));
  close(a!.speedFactor, clamp01(25 / SPEED_SATURATION_BASE_TPS), 1e-12, "assessed S");
});

test("speed expectation: absent, zero, and positive expectations shape S without gating", () => {
  // Absent expectation saturates at the bare base.
  const absent = expectAccepted(cand({ effectiveTps: 150 }));
  close(absent!.speedFactor, clamp01(150 / SPEED_SATURATION_BASE_TPS), 1e-12, "S without expectation");
  // expectedTps 0 behaves exactly like an absent expectation.
  const zero = expectAccepted(cand({ effectiveTps: 150, expectedTps: 0 }));
  close(zero!.speedFactor, absent!.speedFactor, 1e-12, "S with expectedTps 0 matches absent");
  // expectedTps 200 raises the ceiling to 300: 150 scores 0.5, 300 saturates.
  const below = expectAccepted(cand({ effectiveTps: 150, expectedTps: 200 }));
  close(below!.speedFactor, 0.5, 1e-12, "S(150) expecting 200");
  const atCeiling = expectAccepted(cand({ effectiveTps: 300, expectedTps: 200 }));
  close(atCeiling!.speedFactor, 1, 1e-12, "S(300) expecting 200");
  const above = expectAccepted(cand({ effectiveTps: 900, expectedTps: 200 }));
  close(above!.speedFactor, 1, 1e-12, "S saturated above 300");
  // The same absolute TPS is worth less to a task that expects a fast model.
  assert.ok(absent!.speedFactor > below!.speedFactor);
});

test("expected TPS never bypasses the minimumTps hard gate", () => {
  for (const expectedTps of [undefined, 0, 200, 1000]) {
    expectRejected(
      cand({ minimumTps: 100, effectiveTps: 50, expectedTps }),
      "speed_below_minimum"
    );
  }
  // At exactly the gate the candidate is admitted and scored with the expectation.
  const met = expectAccepted(cand({ minimumTps: 5, effectiveTps: 5, expectedTps: 200 }));
  close(met!.speedFactor, 5 / 300, 1e-12, "S at the gate with an expectation");
});

test("a present but invalid expectedTps rejects the candidate as invalid_speed", () => {
  for (const expectedTps of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    expectRejected(cand({ expectedTps }), "invalid_speed");
  }
});

test("candidates differing only in effectiveTps keep their relative order", () => {
  const slower = cand({ canonicalId: "slower", effectiveTps: 60, expectedTps: 200 });
  const faster = cand({ canonicalId: "faster", effectiveTps: 240, expectedTps: 200 });
  const result = rankAutoRoutingCandidates([slower, faster]);
  assert.deepEqual(rankedIds(result), ["faster", "slower"]);
});

test("unknown tier uses zero headroom for Q; verified efficiency is ignored without trusted headroom", () => {
  const unknown = expectAccepted(cand({ requiredQuota: [q("u", rollingEv(50))] }));
  assert.equal(unknown!.tier, "unknown");
  close(unknown!.headroom, ZERO_QUOTA_HEADROOM, 1e-12, "zero H");
  close(unknown!.quotaQuality, ZERO_QUOTA_HEADROOM, 1e-12, "Q=zero");
  // An aggregate unknown quota carries no trusted headroom, so efficiency can
  // never lift Q: it is ignored outright.
  const blended = expectAccepted(
    cand({ requiredQuota: [q("u", rollingEv(50))], verifiedEfficiency: coveredEfficiency(0.9) })
  );
  assert.equal(blended!.verifiedEfficiency, null);
  close(blended!.quotaQuality, ZERO_QUOTA_HEADROOM, 1e-12, "Q stays zero");
  assert.ok(
    blended!.notes.includes("quota_burn_efficiency_evidence_without_trusted_headroom_ignored")
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
    cand({ minimumTps: 100, effectiveTps: 50, referenceUsdPerM: 0 }),
    "speed_below_minimum"
  );
  const accepted = expectAccepted(
    cand({ minimumTps: 5, effectiveTps: 5, referenceUsdPerM: 0 })
  );
  close(accepted!.speedFactor, clamp01(5 / SPEED_SATURATION_BASE_TPS), 1e-12, "min met S");
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
  // (weighted 0.4 => -0.0225), so the discounted candidate ranks first.
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
  // (P(4)=0.475 vs P(2)=0.6, weighted 0.4 => -0.05), so the higher-efficiency
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
  // c1: P(6)=0.35, Q0.5  -> 0.14 + 0.0375 + 0.1 + 0.1 = 0.3775
  // c2: P(1)=0.75, Q0.8  -> 0.30 + 0.0375 + 0.16 + 0.1 = 0.5975
  // c3: P(30)=0.05, Q0.95 -> 0.02 + 0.0375 + 0.19 + 0.1 = 0.3475
  const forward = rankAutoRoutingCandidates([c1, c2, c3]);
  const reversed = rankAutoRoutingCandidates([c3, c2, c1]);
  assert.deepEqual(rankedIds(forward), ["c2", "c1", "c3"]);
  assert.deepEqual(rankedIds(reversed), ["c2", "c1", "c3"]);
});

test("DS prices 1.2 vs 0.6 produce a score delta of 0.044 with other inputs equal", () => {
  const a = cand({ canonicalId: "ds-1.2", referenceUsdPerM: 1.2 });
  const b = cand({ canonicalId: "ds-0.6", referenceUsdPerM: 0.6 });
  const [ea, eb] = [a, b].map((x) => expectAccepted(x)!);
  // P(1.2)=0.72, P(0.6)=0.83 -> delta P 0.11, weighted by P=0.4 -> 0.044
  close(ea.priceFactor, interpPrice(1.2), 1e-12, "P(1.2)");
  close(eb.priceFactor, interpPrice(0.6), 1e-12, "P(0.6)");
  close(eb.score - ea.score, 0.044, 1e-9, "delta 0.044");
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
    requiredQuota: [q("u", rollingEv(50))], // Q = 0
  });
  const blocked = cand({
    canonicalId: "blocked-x",
    requiredQuota: [q("z", rollingEv(0))],
  });
  const result = rankAutoRoutingCandidates([healthyLow, unknownHigh, blocked]);
  // The cheaper unknown candidate still wins by total score with Q = 0.
  assert.deepEqual(rankedIds(result), ["unknown-high", "healthy-low"]);
  assert.deepEqual(
    result.excluded.map((entry) => [entry.canonicalId, entry.reason]),
    [["blocked-x", "quota_blocked"]]
  );
});

test("balance-only quota keeps zero headroom and stays efficiency-ineligible", () => {
  // A pay-as-you-go balance is available (healthy, not blocked) but grants no
  // quota headroom, so Q remains 0 and verified efficiency cannot add a bonus.
  const input = cand({
    canonicalId: "balance-only",
    referenceUsdPerM: 2,
    effectiveCapUsdPerM: 20,
    requiredQuota: [
      {
        id: "deepseek-balance",
        evidence: null,
        kind: "balance",
        balance: { amount: "12.50", observedAtMs: NOW - 1_000, validForMs: HOUR_MS },
      },
    ],
    verifiedEfficiency: coveredEfficiency(0.9),
  });
  const assessment = expectAccepted(input)!;
  assert.equal(assessment.tier, "healthy");
  assert.equal(assessment.coverageComplete, true);
  assert.equal(assessment.headroom, ZERO_QUOTA_HEADROOM);
  close(assessment.quotaQuality, ZERO_QUOTA_HEADROOM, 1e-12, "balance-only Q is zero");
  assert.equal(assessment.verifiedEfficiency, null);
  assert.ok(
    assessment.notes.includes("quota_burn_efficiency_evidence_without_trusted_headroom_ignored")
  );
  // The scored candidate loses exactly the Q term when the balance replaces the
  // default healthy subscription constraint.
  close(assessment.score, expScore(input, assessment), 1e-12, "balance-only score");
});

test("aggregate unknown quota stays eligible with zero headroom and no efficiency bonus", () => {
  const assessment = expectAccepted(
    cand({
      canonicalId: "unknown-eff",
      requiredQuota: [q("u", rollingEv(50))],
      verifiedEfficiency: coveredEfficiency(0.9),
    })
  )!;
  // Unknown headroom never rejects: the candidate remains eligible.
  assert.equal(assessment.tier, "unknown");
  assert.equal(assessment.headroom, ZERO_QUOTA_HEADROOM);
  close(assessment.quotaQuality, ZERO_QUOTA_HEADROOM, 1e-12, "unknown Q stays zero");
  assert.equal(assessment.verifiedEfficiency, null);
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
    referenceUsdPerM: 0, // zero reference also P=1
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

test("recommendation contributes to total score without overriding a cheaper faster high", () => {
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
  assert.deepEqual(rankedIds(result), ["high-cand", "premium-cand"])
  assert.ok(result.ranked[0].score > result.ranked[1].score)
  assert.equal(result.ranked[0].intelligenceShortfall, 1)
  assert.equal(result.ranked[1].intelligenceShortfall, 0)
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

test("confirmed-free uses zero routing price while preserving list price and other gates", () => {
  const free = confirmedFreeSupply();
  const accepted = expectAccepted(
    cand({
      canonicalId: "free-over-cap",
      referenceUsdPerM: 7,
      effectiveCapUsdPerM: 6,
      confirmedFreeSupply: free,
    })
  )!;
  assert.equal(accepted.referenceUsdPerM, 7);
  assert.equal(accepted.routingPriceUsdPerM, 0);
  assert.equal(accepted.priceFactor, 1);
  expectRejected(cand({ referenceUsdPerM: 7, effectiveCapUsdPerM: 6 }), "reference_above_cap");
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

// ---------------------------------------------------------------------------
// Provider-verified unknown-quota floor
// ---------------------------------------------------------------------------

function unknownQuotaFloor() {
  return {
    kind: "unknown_quota_floor" as const,
    appliesFromMs: NOW - MINUTE_MS,
    appliesUntilMs: NOW + HOUR_MS,
    source: "codebuddy.credential_environment",
    ruleId: "codebuddy.ioa_unknown_quota_floor",
    worst_applicable: "worst_applicable" as const,
  };
}

/** A candidate whose aggregate quota is genuinely unobservable. */
function unknownQuotaCandidate(over: Partial<CandidateInput> = {}): CandidateInput {
  return cand({
    canonicalId: "unknown-quota",
    requiredQuota: [q("monthly", rollingEv(50))],
    ...over,
  });
}

test("unknown-quota floor raises Q to the floor while the aggregate stays unknown", () => {
  const without = expectAccepted(unknownQuotaCandidate({ canonicalId: "no-floor" }))!;
  assert.equal(without.headroom, ZERO_QUOTA_HEADROOM);
  assert.equal(without.quotaQuality, ZERO_QUOTA_HEADROOM);
  assert.equal(without.unknownQuotaFloorApplied, false);

  const input = unknownQuotaCandidate({ unknownQuotaFloor: unknownQuotaFloor() });
  const applied = expectAccepted(input)!;
  assert.equal(applied.unknownQuotaFloorApplied, true);
  close(applied.quotaQuality, UNKNOWN_QUOTA_FLOOR_HEADROOM, 1e-12, "floored Q");
  assert.ok(applied.notes.includes("unknown_quota_floor_applied"));

  // The floor touches Q only: H, the tier, coverage and headroom trust are
  // unchanged, and the score moves by exactly weights.Q * floor over the same
  // candidate without the evidence.
  assert.equal(applied.headroom, ZERO_QUOTA_HEADROOM);
  assert.equal(applied.tier, "unknown");
  assert.equal(applied.tier, without.tier);
  assert.equal(applied.coverageComplete, without.coverageComplete);
  assert.equal(applied.headroomTrusted, without.headroomTrusted);
  close(
    applied.score - without.score,
    SCORE_WEIGHTS.Q * UNKNOWN_QUOTA_FLOOR_HEADROOM,
    1e-12,
    "floored score delta"
  );
  close(applied.score, expScore(input, applied), 1e-12, "mirrored floored score");
});

test("trusted healthy headroom ignores the floor", () => {
  const input = cand({
    canonicalId: "trusted-headroom",
    requiredQuota: [q("monthly", hQ(0.9))],
    unknownQuotaFloor: unknownQuotaFloor(),
  });
  const assessed = expectAccepted(input)!;
  assert.equal(assessed.unknownQuotaFloorApplied, false);
  assert.equal(assessed.headroomTrusted, true);
  assert.equal(assessed.tier, "healthy");
  close(assessed.quotaQuality, assessed.headroom, 1e-12, "raw trusted Q");
  assert.ok(
    assessed.notes.includes("unknown_quota_floor_with_trusted_headroom_ignored")
  );
  assert.equal(assessed.notes.includes("unknown_quota_floor_applied"), false);
});

test("a blocked quota still rejects with quota_blocked under floor evidence", () => {
  const result = rankAutoRoutingCandidates([
    unknownQuotaCandidate({
      canonicalId: "floor-blocked",
      requiredQuota: [q("rolling", rollingEv(0))],
      unknownQuotaFloor: unknownQuotaFloor(),
    }),
  ]);
  assert.deepEqual(rankedIds(result), []);
  assert.deepEqual(
    result.excluded.map((entry) => [entry.canonicalId, entry.reason]),
    [["floor-blocked", "quota_blocked"]]
  );
});

test("malformed or stale floor evidence is ignored", () => {
  const wrongKind = expectAccepted(
    unknownQuotaCandidate({
      unknownQuotaFloor: { ...unknownQuotaFloor(), kind: "confirmed_free" as never },
    })
  )!;
  assert.equal(wrongKind.unknownQuotaFloorApplied, false);
  assert.equal(wrongKind.quotaQuality, ZERO_QUOTA_HEADROOM);
  assert.ok(wrongKind.notes.includes("unknown_quota_floor_evidence_invalid_ignored"));

  const missingSource = expectAccepted(
    unknownQuotaCandidate({
      unknownQuotaFloor: { ...unknownQuotaFloor(), source: "" },
    })
  )!;
  assert.equal(missingSource.unknownQuotaFloorApplied, false);
  assert.ok(missingSource.notes.includes("unknown_quota_floor_evidence_invalid_ignored"));

  const missingRule = expectAccepted(
    unknownQuotaCandidate({
      unknownQuotaFloor: { ...unknownQuotaFloor(), ruleId: "" },
    })
  )!;
  assert.equal(missingRule.unknownQuotaFloorApplied, false);
  assert.ok(missingRule.notes.includes("unknown_quota_floor_evidence_invalid_ignored"));

  const missingMarker = expectAccepted(
    unknownQuotaCandidate({
      unknownQuotaFloor: { ...unknownQuotaFloor(), worst_applicable: "best" as never },
    })
  )!;
  assert.equal(missingMarker.unknownQuotaFloorApplied, false);
  assert.ok(missingMarker.notes.includes("unknown_quota_floor_evidence_invalid_ignored"));

  const stale = expectAccepted(
    unknownQuotaCandidate({
      unknownQuotaFloor: { ...unknownQuotaFloor(), appliesUntilMs: NOW + 1 },
    })
  )!;
  assert.equal(stale.unknownQuotaFloorApplied, false);
  assert.equal(stale.quotaQuality, ZERO_QUOTA_HEADROOM);
  assert.ok(
    stale.notes.includes("unknown_quota_floor_interval_does_not_cover_timeout_horizon")
  );
});

test("verified quota-burn efficiency and the floor never both apply", () => {
  // Efficiency requires a trusted positive headroom, so a floor-applicable
  // unknown aggregate can never carry the blend: the floor alone sets Q.
  const efficiency = {
    efficiencyScore: 0.5,
    appliesFromMs: NOW - MINUTE_MS,
    appliesUntilMs: NOW + HOUR_MS,
    source: "quota-burn",
    ruleId: "efficiency-fixture",
    domain: "quota_burn_efficiency" as const,
    worst_applicable: "worst_applicable" as const,
  };
  const input = unknownQuotaCandidate({
    canonicalId: "floor-and-efficiency",
    verifiedEfficiency: efficiency,
    unknownQuotaFloor: unknownQuotaFloor(),
  });
  const assessed = expectAccepted(input)!;
  assert.equal(assessed.verifiedEfficiency, null);
  assert.equal(assessed.unknownQuotaFloorApplied, true);
  close(assessed.quotaQuality, UNKNOWN_QUOTA_FLOOR_HEADROOM, 1e-12, "floor-only Q");
  assert.ok(
    assessed.notes.includes("quota_burn_efficiency_evidence_without_trusted_headroom_ignored")
  );
  close(assessed.score, expScore(input, assessed), 1e-12, "mirrored floor-only score");
});
