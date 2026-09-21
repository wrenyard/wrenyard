import type { IntelligenceTier } from '@wrenyard/catalog';
import type { TaskDispatchRequirements } from '@wrenyard/auto-routing';

/**
 * Immutable typed dispatch requirement presets.
 *
 * Single source of truth for builtin task dispatch requirements, expressed with
 * the `@wrenyard/auto-routing` `TaskDispatchRequirements` contract. Every builtin
 * task references exactly one of these presets via `config.dispatch`, matching
 * its historical `agentRuntime` cost/intelligence class, so no task duplicates
 * the requirement logic.
 *
 * Class mapping:
 *   - FREQUENT  — frequent mechanical / fast / explore tasks
 *   - COMMIT    — frequent mechanical git work with a lower speed expectation
 *   - GENERAL   — general tasks
 *   - REVIEW    — explicit review / judgment tasks
 *   - ULTRA     — ultra tasks
 */

/** Frequent explore / edit / test tasks use speed, intelligence, and price requirements. */
export const FREQUENT_DISPATCH_REQUIREMENTS = {
  expectedTps: 200,
  minimumTps: 60,
  intelligenceMin: 'low' as IntelligenceTier,
  intelligenceExpected: 'mid' as IntelligenceTier,
  maxOutputUsdPerMillion: 6,
} satisfies TaskDispatchRequirements

/**
 * Commit tasks: frequent mechanical git work whose wall time is dominated by
 * staging and verification rather than generation, so it keeps the frequent
 * price and intelligence class with a lower speed expectation.
 */
export const COMMIT_DISPATCH_REQUIREMENTS = {
  expectedTps: 100,
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
  expectedTps: 100,
  minimumTps: 30,
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
  expectedTps: 100,
  minimumTps: 30,
  intelligenceMin: 'high' as IntelligenceTier,
  intelligenceExpected: 'high' as IntelligenceTier,
  maxOutputUsdPerMillion: 60,
} satisfies TaskDispatchRequirements

/**
 * Ultra tasks: historical ultra cost / intelligence class with explicit
 * bounded values (high intelligence minimum, permissive output cost ceiling).
 */
export const ULTRA_DISPATCH_REQUIREMENTS = {
  expectedTps: 60,
  minimumTps: 20,
  intelligenceMin: 'high' as IntelligenceTier,
  intelligenceExpected: 'premium' as IntelligenceTier,
  maxOutputUsdPerMillion: 60,
} satisfies TaskDispatchRequirements
