export type IntelligenceTier = 'low' | 'mid' | 'high' | 'premium';
export type ModelCapability = 'text' | 'image';

/**
 * Unified product-owned reasoning effort ladder. `none` disables reasoning; the
 * `low`..`max` levels ascend weak-to-strong. `default` is an out-of-band
 * provider-default sentinel: it asks the route to use its own upstream-native
 * behaviour, materializes no explicit reasoning field, and is never ranked on
 * the weak-to-strong scale. This is the single public effort vocabulary; how a
 * concrete runtime materializes a level is decided only by that provider
 * module's route-owned declarations.
 */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const INTELLIGENCE_TIERS = ['low', 'mid', 'high', 'premium'] as const;

/** The provider-default sentinel level: upstream-native behaviour with no explicit effort. */
export const PROVIDER_DEFAULT_REASONING: ReasoningEffort = 'default';

/**
 * Public effort vocabulary. `none` and `low`..`max` form the weak-to-strong
 * numeric ladder; the provider-default sentinel `default` is out-of-band and is
 * listed last only so the vocabulary is complete. It carries a neutral rank of
 * its own instead of that list position, so it can never rank stronger than
 * `max`.
 */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'default'] as const;

/** Chinese display labels for every effort level. */
export const REASONING_EFFORT_NAMES: Readonly<Record<ReasoningEffort, string>> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  default: '默认',
};

/**
 * Neutral out-of-band rank of the provider-default sentinel. `default` is not a
 * point on the weak-to-strong scale, so it is given a rank outside the numeric
 * ladder (below `none`) rather than a fabricated effort position; it therefore
 * can never rank stronger than `max`.
 */
const PROVIDER_DEFAULT_REASONING_RANK = -1;

const REASONING_EFFORT_ORDER = Object.fromEntries(
  REASONING_EFFORTS.map((effort, index) => [
    effort,
    effort === PROVIDER_DEFAULT_REASONING ? PROVIDER_DEFAULT_REASONING_RANK : index,
  ]),
) as Readonly<Record<ReasoningEffort, number>>;

/**
 * Rank of an effort level; the sole ordering authority. `none` and `low`..`max`
 * keep their unchanged ascending ranks; the out-of-band `default` sentinel is
 * special-cased to its neutral rank.
 */
export function reasoningEffortRank(effort: ReasoningEffort): number {
  return effort === PROVIDER_DEFAULT_REASONING
    ? PROVIDER_DEFAULT_REASONING_RANK
    : REASONING_EFFORT_ORDER[effort];
}

/**
 * Resolve a requested effort against a non-empty set of supported levels: the
 * nearest supported level at or above the request, else the highest supported
 * level. The expectation is required. Throws when
 * `supported` is empty.
 *
 * The provider-default sentinel is out-of-band:
 * - a route whose whole ladder is the singleton `['default']` resolves to
 *   `default` for any request;
 * - a requested `default` is satisfied only by a ladder that actually declares
 *   it, and is otherwise rejected outright rather than silently resolving to
 *   `max`;
 * - the numeric weak-to-strong search never selects `default` from a mixed
 *   ladder.
 */
export function resolveReasoningEffort(
  expected: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  if (supported.length === 0) {
    throw new Error('supported reasoning efforts must not be empty');
  }
  if (!REASONING_EFFORTS.includes(expected)) throw new Error('expected reasoning effort is required and must be valid');
  if (supported.length === 1 && supported[0] === PROVIDER_DEFAULT_REASONING) {
    return PROVIDER_DEFAULT_REASONING;
  }
  if (expected === PROVIDER_DEFAULT_REASONING) {
    if (supported.includes(PROVIDER_DEFAULT_REASONING)) return PROVIDER_DEFAULT_REASONING;
    throw new Error('requested reasoning effort "default" is not supported by this route');
  }
  const ordered = supported
    .filter((effort) => effort !== PROVIDER_DEFAULT_REASONING)
    .sort((a, b) => REASONING_EFFORT_ORDER[a] - REASONING_EFFORT_ORDER[b]);
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

/**
 * Catalog defaults for a registered canonical model. `capabilities` and
 * `contextWindow` are always known. `intelligence`, `speed` and `pricing` are
 * optional: a canonical identity registered from raw upstream data (identity
 * and display name only) leaves them absent, and no placeholder value is ever
 * invented to satisfy a required field.
 */
export interface ModelDefaults {
  intelligence?: IntelligenceTier;
  capabilities: readonly ModelCapability[];
  contextWindow: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
  speed?: number;
  /**
   * Explicit free-status classification: the identity is genuinely free to
   * use, independent of any list price. Free status is authoritative in its own
   * right and is NEVER inferred from a price of zero — a priced-at-zero row is
   * not automatically free, and a free row keeps whatever pricing it declares.
   * Every consumer that treats a model as free must branch on this flag.
   */
  free?: boolean;
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
