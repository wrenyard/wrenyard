/**
 * The single four-level quota-state concept. A pure function of the frozen
 * per-route constraints and the snapshot time; it reads no IO and never
 * consults a quota source of its own.
 */
import type { BalanceEvidence, QuotaEvidence, RequiredQuotaConstraint } from './types.ts';

export type QuotaStateName = 'abundant' | 'sufficient' | 'insufficient' | 'exhausted';

const WORST_ORDER: Readonly<Record<QuotaStateName, number>> = {
  abundant: 0,
  sufficient: 1,
  insufficient: 2,
  exhausted: 3,
};

/** Parse a raw decimal balance amount; an unparseable or empty string is unknown. */
function parseAmount(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function balanceStateOf(balance: BalanceEvidence, nowMs: number): QuotaStateName {
  const amount = parseAmount(balance.amount);
  if (amount === undefined) return 'insufficient';
  // A strictly observed zero balance stays exhausted even after the evidence
  // goes stale; staleness only ever relaxes a non-exhausted observation.
  if (amount === 0) return 'exhausted';
  if (nowMs - balance.observedAtMs > balance.validForMs) return 'insufficient';
  if (amount <= 10) return 'insufficient';
  return 'sufficient';
}

function windowStateOf(evidence: QuotaEvidence, nowMs: number): QuotaStateName {
  const remaining = evidence.remainingPercent / 100;
  if (!Number.isFinite(remaining)) return 'insufficient';
  // A strictly observed exhaustion is never relaxed by staleness.
  if (remaining <= 0) return 'exhausted';
  if (nowMs - evidence.observedAtMs > evidence.validForMs) return 'insufficient';

  if (evidence.replenishmentKind === 'full_cycle') {
    const resetAtMs = evidence.resetAtMs;
    const windowMs = evidence.windowMs;
    if (resetAtMs !== undefined
      && windowMs !== undefined
      && Number.isFinite(resetAtMs)
      && Number.isFinite(windowMs)
      && windowMs > 0) {
      // Share of the window still to run. Remaining at least this share means
      // the subscription is not being used ahead of its reset.
      const expectedRemaining = (resetAtMs - nowMs) / windowMs;
      if (remaining >= expectedRemaining) return 'abundant';
      if (remaining <= 0.10) return 'insufficient';
      return 'sufficient';
    }
    // A full-cycle constraint without both bounds carries no pace information;
    // a still-positive balance is usable, so it ranks as sufficient.
    return 'sufficient';
  }

  if (evidence.replenishmentKind === 'rolling_partial') {
    if (remaining >= 0.8) return 'abundant';
    if (remaining <= 0.10) return 'insufficient';
    return 'sufficient';
  }

  return 'sufficient';
}

function constraintStateOf(constraint: RequiredQuotaConstraint, nowMs: number): QuotaStateName {
  const balance = constraint.balance;
  if (balance !== undefined && balance !== null) return balanceStateOf(balance, nowMs);
  if (constraint.evidence === null) return 'insufficient';
  return windowStateOf(constraint.evidence, nowMs);
}

/**
 * Classify one route's quota from its required constraints.
 *
 * - `abundant`: not used ahead of its reset (window) or a free allowance;
 * - `sufficient`: usable, neither abundant nor insufficient;
 * - `insufficient`: nearly used up, unknown by design, or not obtained;
 * - `exhausted`: cannot be used now.
 *
 * The worst state across constraints wins. Null or stale evidence is
 * insufficient unless it strictly shows exhaustion. A route with no evidence
 * at all is abundant when it is confirmed free supply.
 */
export function quotaStateOf(
  constraints: readonly RequiredQuotaConstraint[],
  nowMs: number,
  opts?: { confirmedFreeSupply?: boolean },
): QuotaStateName {
  if (constraints.length === 0) {
    return opts?.confirmedFreeSupply === true ? 'abundant' : 'insufficient';
  }
  let worst: QuotaStateName = 'abundant';
  let hasEvidence = false;
  for (const constraint of constraints) {
    if (constraint.evidence !== null || (constraint.balance !== undefined && constraint.balance !== null)) {
      hasEvidence = true;
    }
    const state = constraintStateOf(constraint, nowMs);
    if (WORST_ORDER[state] > WORST_ORDER[worst]) worst = state;
  }
  // Null evidence with confirmed free supply: the route is a free allowance
  // with no window evidence, which the state table classifies as abundant.
  if (!hasEvidence && opts?.confirmedFreeSupply === true) return 'abundant';
  return worst;
}
