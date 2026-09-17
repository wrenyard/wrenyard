import type { IntelligenceTier, TaskDispatchRequirements } from '@wrenyard/catalog'

/**
 * Immutable typed dispatch requirement presets.
 *
 * Single source of truth for builtin task dispatch requirements, expressed with
 * the `@wrenyard/catalog` `TaskDispatchRequirements` contract. Every builtin
 * task references exactly one of these presets via `config.dispatch`, matching
 * its historical `agentRuntime` cost/intelligence class, so no task duplicates
 * the requirement logic.
 *
 * Class mapping:
 *   - FREQUENT  — frequent mechanical / fast / explore tasks
 *   - GENERAL   — general tasks
 *   - REVIEW    — explicit review / judgment tasks
 *   - ULTRA     — ultra tasks
 */

/** Frequent tasks use speed, intelligence, and price requirements. */
export const FREQUENT_DISPATCH_REQUIREMENTS = {
  expectedTps: 80,
  minimumTps: 60,
  intelligenceMin: 'low' as IntelligenceTier,
  intelligenceExpected: 'mid' as IntelligenceTier,
  maxOutputUsdPerMillion: 6,
} satisfies TaskDispatchRequirements

/**
 * General tasks: historical general cost / intelligence class with explicit
 * bounded values (mid intelligence minimum, moderate output cost ceiling).
 */
export const GENERAL_DISPATCH_REQUIREMENTS = {
  expectedTps: 40,
  minimumTps: 20,
  intelligenceMin: 'mid' as IntelligenceTier,
  intelligenceExpected: 'mid' as IntelligenceTier,
  maxOutputUsdPerMillion: 18,
} satisfies TaskDispatchRequirements

/**
 * Review / judgment tasks: explicit review workloads that demand high-grade
 * reasoning. A high intelligence minimum with a permissive output cost ceiling
 * (maxOutputUsdPerMillion 60) and no unrelated model/profile exclusions.
 */
export const REVIEW_DISPATCH_REQUIREMENTS = {
  expectedTps: 40,
  minimumTps: 20,
  intelligenceMin: 'high' as IntelligenceTier,
  intelligenceExpected: 'high' as IntelligenceTier,
  maxOutputUsdPerMillion: 60,
} satisfies TaskDispatchRequirements

/**
 * Ultra tasks: historical ultra cost / intelligence class with explicit
 * bounded values (high intelligence minimum, permissive output cost ceiling).
 */
export const ULTRA_DISPATCH_REQUIREMENTS = {
  expectedTps: 20,
  minimumTps: 8,
  intelligenceMin: 'high' as IntelligenceTier,
  intelligenceExpected: 'premium' as IntelligenceTier,
  maxOutputUsdPerMillion: 60,
} satisfies TaskDispatchRequirements
