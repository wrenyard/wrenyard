import { models, PROVIDER_DEFAULT_REASONING, type ReasoningEffort } from '@wrenyard/models';
import type { GatewayProtocol, ProviderDefinition, ModelDefinition, ProtocolCapability } from './catalog.ts';

/**
 * One provider-side model declaration.
 *
 * `id` is the registered model identity and is required: a declaration can
 * never introduce a provider-local public model. `upstreamId` is the exact
 * private wire name the upstream expects when it differs from the registered
 * id; `defineProvider` derives the protocol `upstreamModels` table from it.
 *
 * Field ownership is explicit:
 * - intelligence and speed are identity-owned and always come from the
 *   registry; a provider declaration cannot override either one;
 * - pricing, context/output limits, capabilities and free status fall back to
 *   the registered defaults field by field when the declaration omits them,
 *   unless the declaration opts in to `ownsMetadata`, in which case those
 *   fields describe only what its source reported and an omitted value stays
 *   absent. No value is ever fabricated either way.
 */
type RawModelDefinition = Omit<ModelDefinition, 'displayName' | 'canonicalModel' | 'speed' | 'intelligence' | 'reasoningEfforts' | 'protocols'> & {
  displayName?: string;
  reasoningEfforts?: readonly ReasoningEffort[];
  /** Per-offering protocol override; absent rows inherit the provider's
   * `modelProtocols` batch declaration at resolve time. */
  protocols?: readonly GatewayProtocol[];
};

/**
 * Provider-only differences for a registered canonical model. The registered
 * model supplies its exact id, its display name, its canonical identity, its
 * intelligence tier and its default speed, so an override is only legitimate
 * when the provider genuinely differs (a free entitlement, verified
 * context/output metadata, Claude family metadata, a route-owned effort ladder,
 * a private upstream wire id, …).
 */
export type CanonicalModelOverrides = Omit<RawModelDefinition, 'id'>;

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
 * - a raw definition: a registered id plus the provider-owned fields directly.
 *
 * A route that declares a `reasoningEfforts` ladder owns it: it is never
 * inferred from the registry or a model id.
 */
export type ProviderModel = string | CanonicalModelSelection | RawModelDefinition;

type RawProviderDefinition = Omit<ProviderDefinition, 'models'> & {
  models: readonly ProviderModel[];
  /** The explicit per-provider batch declaration stamped onto every resolved
   * offering that does not override `protocols` itself. An EMPTY array means
   * every resolved offering has no gateway protocol (native-only provider). */
  modelProtocols: readonly GatewayProtocol[];
};

export const model = (
  id: string,
  contextWindow?: number,
  maxTokens?: number,
  upstreamId?: string,
  reasoningEfforts?: readonly ReasoningEffort[],
): RawModelDefinition => ({
  id,
  ...(upstreamId === undefined || upstreamId === id ? {} : { upstreamId }),
  ...(contextWindow ? { contextWindow } : {}),
  ...(maxTokens ? { maxTokens } : {}),
  ...(reasoningEfforts ? { reasoningEfforts } : {}),
});

export const openAI = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'openai_chat' as const, endpoint, authScheme });
export const anthropic = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'anthropic_messages' as const, endpoint, authScheme });

/** The single provider-default ladder materialized for a ladder-less route of a
 * provider that opted in to `usesProviderDefaultReasoning`. */
const PROVIDER_DEFAULT_LADDER: readonly ReasoningEffort[] = [PROVIDER_DEFAULT_REASONING];

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

function isCanonicalSelection(declaration: ProviderModel): declaration is CanonicalModelSelection {
  return typeof declaration === 'object'
    && declaration !== null
    && typeof (declaration as CanonicalModelSelection).canonical === 'string';
}

/**
 * Resolve one declaration onto its registered model. The reference is
 * mandatory: an unregistered id is a broken declaration, never a new provider
 * model. Intelligence and speed are identity-owned and always come from the
 * registry; a provider declaration cannot override either, and the registry
 * invariant guarantees both are present.
 *
 * Pricing, limits, capabilities and free status fall back to the registered
 * defaults field by field when the declaration omits them, unless the
 * declaration owns its upstream metadata: then an omitted field stays absent
 * and is never refilled from an unrelated registry default, and neither source
 * can fabricate a value the other does not supply.
 */
function resolveModelDefaults(
  def: RawModelDefinition,
  usesProviderDefaultReasoning: boolean,
  modelProtocols: readonly GatewayProtocol[],
): ModelDefinition {
  const registered = models.require(def.id);
  // A route that declares its own effort ladder owns it. A route that declares
  // none resolves to an EMPTY ladder (unknown / no selectable level) unless its
  // provider opted in to the provider-default sentinel, in which case the
  // singleton ['default'] ladder is materialized. A ladder is never inferred
  // from the registry or a model id.
  const reasoningEfforts = def.reasoningEfforts
    ?? (usesProviderDefaultReasoning ? PROVIDER_DEFAULT_LADDER : []);
  const { defaults } = registered;
  // A declaration that owns its upstream metadata never regains a value its
  // source omitted: only identity-owned speed and intelligence come from the
  // registry.
  const fallback = def.ownsMetadata === true ? undefined : defaults;
  return {
    ...def,
    displayName: def.displayName ?? registered.displayName,
    canonicalModel: { id: registered.id, displayName: registered.displayName },
    reasoningEfforts,
    protocols: def.protocols ?? modelProtocols,
    // Identity-owned metadata: never sourced from the declaration.
    intelligence: registered.defaults.intelligence,
    speed: registered.defaults.speed,
    capabilities: def.capabilities ?? fallback?.capabilities,
    contextWindow: def.contextWindow ?? fallback?.contextWindow,
    maxTokens: def.maxTokens ?? def.maxOutputTokens ?? fallback?.maxOutputTokens,
    maxOutputTokens: def.maxOutputTokens ?? def.maxTokens ?? fallback?.maxOutputTokens,
    pricing: def.pricing ?? fallback?.pricing,
    // Free status is an explicit classification carried from the provider
    // override or, failing that, the canonical registry default. It is never
    // derived from `pricing`.
    free: def.free ?? fallback?.free,
  };
}

/** Resolve one provider model declaration into a complete definition. */
export function resolveProviderModel(
  declaration: ProviderModel,
  usesProviderDefaultReasoning = false,
  modelProtocols: readonly GatewayProtocol[] = [],
): ModelDefinition {
  if (typeof declaration === 'string') {
    return resolveModelDefaults({ id: declaration }, usesProviderDefaultReasoning, modelProtocols);
  }
  if (isCanonicalSelection(declaration)) {
    const { canonical, overrides } = declaration;
    return resolveModelDefaults({ ...overrides, id: canonical }, usesProviderDefaultReasoning, modelProtocols);
  }
  return resolveModelDefaults(declaration, usesProviderDefaultReasoning, modelProtocols);
}

/**
 * Derive each protocol capability's private `upstreamModels` table from the
 * resolved offerings. Translation is keyed by the registered model id, so the
 * outbound request still carries the exact upstream spelling while every
 * public identity stays registered. An explicit per-protocol mapping wins over
 * the model-level binding.
 */
function deriveProtocols(
  protocols: readonly ProtocolCapability[] | undefined,
  offerings: readonly ModelDefinition[],
): readonly ProtocolCapability[] | undefined {
  if (protocols === undefined) return undefined;
  const derived = Object.fromEntries(
    offerings.flatMap((entry) =>
      entry.upstreamId === undefined || entry.upstreamId === entry.id ? [] : [[entry.id, entry.upstreamId] as const]),
  );
  if (Object.keys(derived).length === 0) return protocols;
  return protocols.map((capability) => ({
    ...capability,
    upstreamModels: { ...derived, ...capability.upstreamModels },
  }));
}

export function defineProvider(provider: RawProviderDefinition): ProviderDefinition {
  const usesProviderDefaultReasoning = provider.usesProviderDefaultReasoning === true;
  const offerings = provider.models.map((declaration) =>
    resolveProviderModel(declaration, usesProviderDefaultReasoning, provider.modelProtocols));
  return {
    ...provider,
    models: offerings,
    protocols: deriveProtocols(provider.protocols, offerings),
  };
}
