import { builtinModelDisplayName, models, type ReasoningEffort } from '@wrenyard/models';
import type { ProviderDefinition, IntelligenceTier, ModelDefinition, ModelPricing } from './catalog.ts';

type RawModelDefinition = Omit<ModelDefinition, 'speed' | 'intelligence' | 'pricing' | 'reasoningEfforts'> & {
  speed?: number;
  intelligence?: IntelligenceTier;
  pricing?: ModelPricing;
  reasoningEfforts?: readonly ReasoningEffort[];
};

/**
 * Provider-only differences for a registered canonical model. The registered
 * canonical model supplies its exact id, its display name, its canonical
 * identity and every field not listed here, so an override is only legitimate
 * when the provider genuinely differs (a free entitlement, verified
 * context/output metadata, Claude family metadata, a route-owned effort
 * ladder, …).
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
 * - a raw definition: a model with no registered canonical model. It carries
 *   only what the route actually knows; metadata it cannot supply stays
 *   genuinely absent, because no default is invented for it.
 *
 * A route that declares a `reasoningEfforts` ladder owns it: it is never
 * inferred from the registry or a model id. A route whose model names no
 * registered canonical model may declare none, and its capabilities then stay
 * unknown rather than fabricated.
 */
export type ProviderModel = string | CanonicalModelSelection | RawModelDefinition;

type RawProviderDefinition = Omit<ProviderDefinition, 'models'> & { models: readonly ProviderModel[] };

export const model = (
  id: string,
  contextWindow?: number,
  maxTokens?: number,
  canonicalId?: string,
  reasoningEfforts?: readonly ReasoningEffort[],
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
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
  };
};

export const openAI = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'openai_chat' as const, endpoint, authScheme });
export const anthropic = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'anthropic_messages' as const, endpoint, authScheme });

// Route-owned effort ladders. These are declaration helpers only: a provider
// chooses the exact subset its transport materializes; nothing is inferred from
// a model id and no provider defaults a missing ladder.
export const REASONING_FULL: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
export const REASONING_LOW_HIGH_MAX: readonly ReasoningEffort[] = ['low', 'high', 'max'];
export const REASONING_UP_TO_XHIGH: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
export const REASONING_MEDIUM_HIGH: readonly ReasoningEffort[] = ['medium', 'high'];

// A level ladder expressed as a runtime effort alias (identity alias). Used for
// native Codex/CodeBuddy effort flags and gateway effort flags.
export const effortLadder = (levels: readonly ReasoningEffort[]): Readonly<Record<string, { effort: string }>> =>
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
  // A route that declares its own effort ladder owns it; a route that declares
  // none resolves to an EMPTY ladder (unknown / no selectable level) rather than
  // inheriting one from the registry or a model id.
  const reasoningEfforts = def.reasoningEfforts ?? [];
  const registered = models.get(def.canonicalModel?.id ?? def.id);
  if (!registered) return completeDefinition(def, reasoningEfforts);
  const { defaults } = registered;
  return {
    ...def,
    reasoningEfforts,
    intelligence: def.intelligence ?? defaults.intelligence,
    capabilities: def.capabilities ?? defaults.capabilities,
    contextWindow: def.contextWindow ?? defaults.contextWindow,
    maxTokens: def.maxTokens ?? def.maxOutputTokens ?? defaults.maxOutputTokens,
    maxOutputTokens: def.maxOutputTokens ?? def.maxTokens ?? defaults.maxOutputTokens,
    speed: def.speed ?? defaults.speed,
    pricing: def.pricing ?? defaults.pricing,
  };
}

/** A definition with no registered canonical model keeps exactly the metadata
 * the route declares. Whatever the route cannot supply stays genuinely
 * absent/unknown; it is never defaulted to a placeholder or invented. The
 * effort ladder is always present, empty when the route declares none. */
function completeDefinition(
  def: RawModelDefinition,
  reasoningEfforts: readonly ReasoningEffort[],
): ModelDefinition {
  // An explicitly declared canonical identity is a reference, never a custom
  // model: an unknown canonical id is a broken reference and stays an error.
  if (def.canonicalModel) throw new Error(`model ${def.id} references unknown canonical model ${def.canonicalModel.id}`);
  return { ...def, reasoningEfforts };
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
