import { builtinModelDisplayName, models } from '@wrenyard/models';
import type { ProviderDefinition, IntelligenceTier, ModelDefinition, ModelPricing, ThinkingLevel } from './catalog.ts';

type RawModelDefinition = Omit<ModelDefinition, 'speed' | 'intelligence' | 'pricing'> & {
  speed?: number;
  intelligence?: IntelligenceTier;
  pricing?: ModelPricing;
};

type RawProviderDefinition = Omit<ProviderDefinition, 'models'> & { models: readonly RawModelDefinition[] };

export const model = (
  id: string,
  contextWindow?: number,
  maxTokens?: number,
  canonicalId?: string,
  thinkingLevels?: readonly ThinkingLevel[],
): RawModelDefinition => {
  const canonical = canonicalId === undefined
    ? undefined
    : { id: canonicalId, displayName: builtinModelDisplayName(canonicalId) };
  return {
    id,
    displayName: canonical?.displayName ?? builtinModelDisplayName(id),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(canonical ? { canonicalModel: canonical } : {}),
    ...(thinkingLevels ? { thinkingLevels } : {}),
  };
};

export const openAI = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'openai_chat' as const, endpoint, authScheme });
export const anthropic = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'anthropic_messages' as const, endpoint, authScheme });

export { THINKING_FULL, THINKING_UP_TO_XHIGH, THINKING_LOW_HIGH_MAX } from '@wrenyard/models';

// A level ladder expressed as a runtime effort alias (identity alias). Used for
// native Codex/CodeBuddy effort flags and gateway effort flags.
export const effortLadder = (levels: readonly ThinkingLevel[]): Readonly<Record<string, { effort: string }>> =>
  Object.fromEntries(levels.map((level) => [level, { effort: level }]));

/** Resolve canonical defaults first; provider fields are explicit overrides. */
function resolveModelDefaults(def: RawModelDefinition): ModelDefinition {
  const { defaults } = models.require(def.canonicalModel?.id ?? def.id);
  return {
    ...def,
    intelligence: def.intelligence ?? defaults.intelligence,
    capabilities: def.capabilities ?? defaults.capabilities,
    thinkingLevels: def.thinkingLevels ?? defaults.thinkingLevels,
    contextWindow: def.contextWindow ?? defaults.contextWindow,
    maxTokens: def.maxTokens ?? def.maxOutputTokens ?? defaults.maxOutputTokens,
    maxOutputTokens: def.maxOutputTokens ?? def.maxTokens ?? defaults.maxOutputTokens,
    speed: def.speed ?? defaults.speed,
    pricing: def.pricing ?? defaults.pricing,
  };
}

export function defineProvider(provider: RawProviderDefinition): ProviderDefinition {
  return { ...provider, models: provider.models.map(resolveModelDefaults) };
}
