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
 * Class mapping (driven by historical `agentRuntime` selectors):
 *   - FREQUENT  ← forge/fast        (frequent mechanical / fast tasks)
 *   - GENERAL   ← forge/general
 *   - ULTRA     ← forge/ultra
 *   - VISION    ← forge/gk-kimi     (vision-specialized, exact routing preserved)
 */

/** Models/profiles excluded across aliases for the strict frequent class. */
const FREQUENT_MODEL_EXCLUSIONS = [
  'glm-5.3',
  'kimi-k3',
  'k3',
  'gpt-5.6-sol',
  'gpt-6-astra',
] as const

const FREQUENT_PROFILE_EXCLUSIONS = [
  'cb-glm',
  'cc-glm',
  'gk-glm',
  'cb-kimi',
  'cc-kimi',
  'gk-kimi',
  'cur-kimi',
  'codex-sol',
  'codex-astra',
] as const

/**
 * Frequent / mechanical / fast tasks: strict throughput and a hard cost
 * ceiling, mid..high intelligence, with explicit model + profile exclusions
 * for GLM-5.3, Kimi K3 (k3), GPT-5.6 Sol, and GPT-6 Astra across aliases.
 */
export const FREQUENT_DISPATCH_REQUIREMENTS = {
  expectedTps: 80,
  minimumTps: 60,
  intelligenceMin: 'mid' as IntelligenceTier,
  intelligenceMax: 'high' as IntelligenceTier,
  maxOutputUsdPerMillion: 6,
  excludeModelIds: [...FREQUENT_MODEL_EXCLUSIONS],
  excludeProfileIds: [...FREQUENT_PROFILE_EXCLUSIONS],
} satisfies TaskDispatchRequirements

/**
 * General tasks: historical general cost / intelligence class with explicit
 * bounded values (mid..high intelligence, moderate output cost ceiling).
 */
export const GENERAL_DISPATCH_REQUIREMENTS = {
  expectedTps: 40,
  minimumTps: 20,
  intelligenceMin: 'mid' as IntelligenceTier,
  intelligenceMax: 'high' as IntelligenceTier,
  maxOutputUsdPerMillion: 18,
} satisfies TaskDispatchRequirements

/**
 * Ultra tasks: historical ultra cost / intelligence class with explicit
 * bounded values (frontier..premium intelligence, permissive output cost ceiling).
 */
export const ULTRA_DISPATCH_REQUIREMENTS = {
  expectedTps: 20,
  minimumTps: 8,
  intelligenceMin: 'frontier' as IntelligenceTier,
  intelligenceMax: 'premium' as IntelligenceTier,
  maxOutputUsdPerMillion: 60,
} satisfies TaskDispatchRequirements

/**
 * Vision-specialized tasks (e.g. look-at): require vision capability and
 * preserve the exact specialized routing (forge/gk-kimi). Frontier intelligence
 * tier (frontier..frontier) with a cost ceiling and no exclusions, so the pinned
 * specialized K3 runtime stays eligible.
 */
export const VISION_DISPATCH_REQUIREMENTS = {
  expectedTps: 20,
  minimumTps: 8,
  intelligenceMin: 'frontier' as IntelligenceTier,
  intelligenceMax: 'frontier' as IntelligenceTier,
  maxOutputUsdPerMillion: 15,
  requiredCapabilities: ['image'],
} satisfies TaskDispatchRequirements
