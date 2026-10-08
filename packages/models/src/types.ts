export type IntelligenceTier = 'low' | 'mid' | 'high' | 'premium';
export type ModelCapability = 'text' | 'image';

/**
 * Unified product-owned reasoning effort ladder. `none` disables reasoning; the
 * remaining levels ascend weak-to-strong. This is the single public effort
 * vocabulary; how a concrete runtime materializes a level is decided only by
 * that provider module's route-owned declarations.
 */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const INTELLIGENCE_TIERS = ['low', 'mid', 'high', 'premium'] as const;

/**
 * Ordered weak-to-strong effort ladder. The index is the only authority for
 * "nearest >= expected else highest" selection.
 */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Chinese display labels for every effort level. */
export const REASONING_EFFORT_NAMES: Readonly<Record<ReasoningEffort, string>> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};

const REASONING_EFFORT_ORDER = Object.fromEntries(REASONING_EFFORTS.map((effort, index) => [effort, index])) as Readonly<Record<ReasoningEffort, number>>;

/** Weak-to-strong rank of an effort level; the sole ordering authority. */
export function reasoningEffortRank(effort: ReasoningEffort): number {
  return REASONING_EFFORT_ORDER[effort];
}

/**
 * Resolve a requested effort against a non-empty set of supported levels: the
 * nearest supported level at or above the request, else the highest supported
 * level. The expectation is required. Throws when
 * `supported` is empty.
 */
export function resolveReasoningEffort(
  expected: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  if (supported.length === 0) {
    throw new Error('supported reasoning efforts must not be empty');
  }
  const ordered = [...supported].sort((a, b) => REASONING_EFFORT_ORDER[a] - REASONING_EFFORT_ORDER[b]);
  if (!REASONING_EFFORTS.includes(expected)) throw new Error('expected reasoning effort is required and must be valid');
  const atOrAbove = ordered.find((effort) => REASONING_EFFORT_ORDER[effort] >= REASONING_EFFORT_ORDER[expected]);
  return atOrAbove ?? ordered[ordered.length - 1]!;
}

/** USD per million tokens: [cached, input, output]. */
export type ModelPricing = readonly [number, number, number];

export interface ModelNativeAttributes {
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: readonly ModelCapability[];
}

export interface ModelDefaults {
  intelligence: IntelligenceTier;
  capabilities: readonly ModelCapability[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing: ModelPricing;
  speed: number;
}

export interface RegisteredModel {
  id: string;
  displayName: string;
  lab: string;
  family?: string;
  version?: string;
  native?: ModelNativeAttributes;
  defaults: ModelDefaults;
}
