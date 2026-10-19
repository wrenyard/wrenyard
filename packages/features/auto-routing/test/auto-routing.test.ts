/**
 * Focused node:test coverage for packages/features/auto-routing/src/index.ts.
 *
 * Covers the pure two-file (source + test) contract: quota evidence
 * semantics, full-cycle/rolling aggregation, hard guards, marginal price,
 * and the approved normalized
 * ranking score:
 *   score = .40*P + .30*S + .20*Q + .10*I
 * where P is the continuous price-factor from fixed anchors,
 * S = min(TPS / (SPEED_SATURATION_BASE_TPS + expectedTps), 1),
 * Q is quota headroom quality, and I is the intelligence factor. Every factor is
 * bounded in [0, 1], so the score is always within [0, 1]. Ranking is
 * deterministic: abundant supply (confirmed free, or healthy quota with trusted
 * headroom) forms a priority tier ahead of every other eligible route, and
 * within each tier candidates sort by descending score; quota tier
 * is retained only as a diagnostic field and is never a sort key.
 *
 * Note: ranking fixtures use synthetic labels ("ds-flash-like",
 * "glm-flash-like") purely to make canonical/snapshot ids readable. No real
 * provider pricing or quota is asserted anywhere.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_WEIGHTS,
  SPEED_SATURATION_BASE_TPS,
  assessRequiredQuota,
  evaluateCandidate,
  rankAutoRoutingCandidates,
  type ScoreWeights,
  type CandidateInput,
  type QuotaEvidence,
  type RequiredQuotaConstraint,
} from "../src/index.ts";

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

/**
 * Full-cycle healthy quota carrying a headroom close to targetH (0.05..1).
 *
 * Headroom is the even blend of the remaining ratio and the cycle pace term:
 *   H = 0.5*remaining + 0.5*pace, pace = clamp((remaining - expected) / 0.1, 0, 1).
 * A high target rests on a saturated pace term — remaining leads the cycle pace
 * by twenty points, twice the ten-point saturation — while a low target takes
 * no pace credit at all and tracks a full-window horizon exactly.
 */
function hQ(targetH: number): QuotaEvidence {
  if (targetH >= 0.6) {
    const remaining = 2 * targetH - 1;
    return fullCycleEv(remaining * 100, remaining - 0.2);
  }
  // reset horizon == window => pace term 0, headroom == 0.5*remainingRatio.
  return fullCycleEv(targetH * 2 * 100, 1);
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
  };
  return { ...base, ...over };
}

// Mirror of the production clamp used by the speed-factor boundary checks.
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
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

// ---------------------------------------------------------------------------
// Invalid / stale / out-of-contract evidence never becomes healthy
// ---------------------------------------------------------------------------

function expectConstraintReject(
  evidence: QuotaEvidence,
  code: string
): void {
  const result = assessRequiredQuota(NOW, [q("bad", evidence)]);
  assert.equal(result.state, "insufficient");
  assert.equal(result.coverageComplete, false);
  const assessment = result.constraints[0];
  assert.equal(assessment.state, "insufficient");
  assert.equal(assessment.rejectCode, code);
}

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

// ---------------------------------------------------------------------------
// Negative aggregation: blocked / strained dominate, never silently healthy
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hard candidate guards
// ---------------------------------------------------------------------------

test("zero remaining exhausts the candidate", () => {
  const exhausted = expectRejected(
    cand({ requiredQuota: [q("zero", rollingEv(0))] }),
    "quota_exhausted"
  );
  assert.ok(exhausted!.detail!.includes("zero"));
});

// ---------------------------------------------------------------------------
// Equal arithmetic-mean aggregation of required quota constraints
// ---------------------------------------------------------------------------

test("any exhausted (zero) constraint rejects the candidate even alongside an abundant peer", () => {
  const exhausted = expectRejected(
    cand({ requiredQuota: [q("z", rollingEv(0)), q("h", rollingEv(90))] }),
    "quota_exhausted"
  );
  assert.ok(exhausted!.detail!.includes("z"));
  const pool = assessRequiredQuota(NOW, [q("z", rollingEv(0)), q("h", rollingEv(90))]);
  assert.equal(pool.state, "exhausted");
  assert.equal(pool.headroom, null);
  assert.deepEqual(pool.exhaustedConstraintIds, ["z"]);
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



// ---------------------------------------------------------------------------
// Approved normalized formula: weights, price anchors, speed, quota, intelligence
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Approved normalized ranking: single global deterministic score order
// ---------------------------------------------------------------------------

test("abundant quota ranks ahead of sufficient even on a lower score", () => {
  // An abundant candidate and a sufficient candidate are in different quota
  // tiers: the abundant route ranks first even though the sufficient
  // candidate has a higher score, and exhausted stays rejected.
  const abundantLow = cand({
    canonicalId: "abundant-low",
    referenceUsdPerM: 30, // P(30)=0.05
    requiredQuota: [q("q", hQ(0.9))], // Q 0.90
  });
  const sufficientHigh = cand({
    canonicalId: "sufficient-high",
    referenceUsdPerM: 0.5, // P(0.5)=0.85
    requiredQuota: [q("u", rollingEv(50))], // Q = 0
  });
  const exhausted = cand({
    canonicalId: "exhausted-x",
    requiredQuota: [q("z", rollingEv(0))],
  });
  const result = rankAutoRoutingCandidates([abundantLow, sufficientHigh, exhausted]);
  // The abundant candidate leads; within the remaining tier score order
  // applies.
  assert.deepEqual(rankedIds(result), ["abundant-low", "sufficient-high"]);
  assert.deepEqual(
    result.excluded.map((entry) => [entry.canonicalId, entry.reason]),
    [["exhausted-x", "quota_exhausted"]]
  );
});

test("confirmed-free candidates share the abundant tier ranked by score", () => {
  // A confirmed-free candidate routes for free (P=1) and belongs to the
  // abundant tier; an abundant-quota route joins the same tier, so the higher
  // score ranks first.
  const free = cand({
    canonicalId: "free-a",
    requiredQuota: [q("rolling", rollingEv(50))], // sufficient -> Q 0
    confirmedFreeSupply: confirmedFreeSupply(),
  });
  const standard = cand({
    canonicalId: "std-a",
    referenceUsdPerM: 0, // zero reference also P=1
    requiredQuota: [q("q", fullCycleEv(80, 1))], // sufficient -> Q 0.8
  });
  const [f, s] = [free, standard].map((x) => expectAccepted(x)!);
  assert.equal(f.supplyClass, "confirmed_free");
  assert.equal(s.supplyClass, "standard");
  assert.equal(f.routingPriceUsdPerM, 0);
  assert.equal(f.priceFactor, 1);
  assert.equal(s.routingPriceUsdPerM, 0);
  assert.equal(s.priceFactor, 1);
  assert.ok(
    s.score > f.score,
    "the measured-quota route keeps the higher score and both share the abundant tier"
  );
  const result = rankAutoRoutingCandidates([free, standard]);
  assert.deepEqual(rankedIds(result), ["std-a", "free-a"]);
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

// ---------------------------------------------------------------------------
// Determinism, canonical tie-breaks, snapshot context, defensive copies
// ---------------------------------------------------------------------------

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
    [["free-blocked", "quota_exhausted"]]
  );
});
