/**
 * Auxiliary role reasoning-effort requirements (data only).
 *
 * A `reason` call carries an explicit caller-selected effort; every auxiliary
 * call (title, memory-search, doc-search, compile, reply) instead declares an
 * ordered ladder of public levels it prefers. `calls.ts` selects the earliest
 * level the ladder shares with the resolved route's own `reasoningEfforts`, and
 * falls back to the nearest supported level at or above the first preference.
 *
 * This module is pure data and the single source of truth for those ladders; it
 * holds no routing or selection logic.
 */
import type { ReasoningEffort } from '@wrenyard/models';

/** One auxiliary role's ordered reasoning-effort preference. */
export interface RoleReasoningRequirement {
  /** Ordered weak-to-strong public levels this role prefers. */
  expectedReasoningEffort: readonly ReasoningEffort[];
}

/** The shared preference for a native-text/structured aux call: no reasoning, else the cheapest. */
const AUXILIARY_EXPECTED: readonly ReasoningEffort[] = ['none', 'low'];

/** Every auxiliary call role that selects its own effort from a preference ladder. */
export type AuxiliaryCallRole = 'title' | 'memory-search' | 'doc-search' | 'compile' | 'reply';

/** Ordered reasoning-effort preference for every auxiliary call role. */
export const ROLE_REQUIREMENTS: Readonly<Record<AuxiliaryCallRole, RoleReasoningRequirement>> = {
  title: { expectedReasoningEffort: AUXILIARY_EXPECTED },
  'memory-search': { expectedReasoningEffort: AUXILIARY_EXPECTED },
  'doc-search': { expectedReasoningEffort: AUXILIARY_EXPECTED },
  compile: { expectedReasoningEffort: AUXILIARY_EXPECTED },
  reply: { expectedReasoningEffort: AUXILIARY_EXPECTED },
};

/** The ordered preference ladder for an auxiliary role, or undefined for `reason`. */
export function auxiliaryReasoningRequirement(role: string): readonly ReasoningEffort[] | undefined {
  return (ROLE_REQUIREMENTS as Readonly<Record<string, RoleReasoningRequirement>>)[role]
    ?.expectedReasoningEffort;
}
