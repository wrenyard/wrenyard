import { builtinModelDisplayName, models } from '@wrenyard/models';
import type { ProviderDefinition, IntelligenceTier, ModelDefinition, ModelPricing, ThinkingLevel } from './catalog.ts';

type RawModelDefinition = Omit<ModelDefinition, 'speed' | 'intelligence' | 'pricing'> & {
  speed?: number;
  intelligence?: IntelligenceTier;
  pricing?: ModelPricing;
};

/**
 * Provider-only differences for a registered canonical model. The registered
 * canonical model supplies its exact id, its display name, its canonical
 * identity and every field not listed here, so an override is only legitimate
 * when the provider genuinely differs (a free entitlement, verified
 * context/output metadata, Claude family metadata, …).
 */
export type CanonicalModelOverrides = Omit<RawModelDefinition, 'id' | 'displayName' | 'canonicalModel'>;

/** A registered canonical model selected by its exact id, plus only the
 * provider differences that actually exist. */
export interface CanonicalModelSelection {
  readonly canonical: string;
  readonly overrides?: CanonicalModelOverrides;
}

/**
 * One provider model declaration:
 * - a string: the exact registered canonical id, published verbatim. Its public
 *   id, display name and canonical identity are all the registry identity and
 *   every field comes from the registry.
 * - `{ canonical, overrides }`: that same registry-backed offering plus only the
 *   differences this provider actually has.
 * - a raw definition: a model with no registered canonical model. It must carry
 *   its own complete metadata, because no default is invented for it.
 */
export type ProviderModel = string | CanonicalModelSelection | RawModelDefinition;

type RawProviderDefinition = Omit<ProviderDefinition, 'models'> & { models: readonly ProviderModel[] };

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

/** A registered canonical model declared verbatim: the registry identity is the
 * public id, the display name and the canonical identity at once. */
function canonicalDefinition(id: string): RawModelDefinition {
  return model(id, undefined, undefined, id);
}

function isCanonicalSelection(declaration: ProviderModel): declaration is CanonicalModelSelection {
  return typeof declaration === 'object'
    && declaration !== null
    && typeof (declaration as CanonicalModelSelection).canonical === 'string';
}

/** Resolve canonical defaults first; provider fields are explicit overrides. */
function resolveModelDefaults(def: RawModelDefinition): ModelDefinition {
  const registered = models.get(def.canonicalModel?.id ?? def.id);
  if (!registered) return completeDefinition(def);
  const { defaults } = registered;
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

/** A definition with no registered canonical model must already be complete: a
 * genuinely custom model never inherits an invented default. */
function completeDefinition(def: RawModelDefinition): ModelDefinition {
  // An explicitly declared canonical identity is a reference, never a custom
  // model: an unknown canonical id is a broken reference and stays an error.
  if (def.canonicalModel) throw new Error(`model ${def.id} references unknown canonical model ${def.canonicalModel.id}`);
  if (def.intelligence === undefined) throw new Error(`custom model ${def.id} declares no intelligence tier`);
  if (def.capabilities === undefined) throw new Error(`custom model ${def.id} declares no capabilities`);
  if (def.pricing === undefined) throw new Error(`custom model ${def.id} declares no pricing`);
  if (def.speed === undefined) throw new Error(`custom model ${def.id} declares no speed`);
  return {
    ...def,
    intelligence: def.intelligence,
    capabilities: def.capabilities,
    pricing: def.pricing,
    speed: def.speed,
  };
}

/** Resolve one provider model declaration into a complete definition. */
export function resolveProviderModel(declaration: ProviderModel): ModelDefinition {
  if (typeof declaration === 'string') return resolveModelDefaults(canonicalDefinition(declaration));
  if (isCanonicalSelection(declaration)) {
    const { canonical, overrides } = declaration;
    return resolveModelDefaults({ ...canonicalDefinition(canonical), ...overrides });
  }
  return resolveModelDefaults(declaration);
}

export function defineProvider(provider: RawProviderDefinition): ProviderDefinition {
  return { ...provider, models: provider.models.map(resolveProviderModel) };
}
