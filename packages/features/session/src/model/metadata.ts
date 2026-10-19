/**
 * Browser-safe model metadata entry.
 *
 * The narrow `@wrenyard/session/model-metadata` subpath: it exposes the pure
 * `resolveModelMetadata` helper together with the per-model protocol-selection
 * helpers, without importing the Node transport/HTTP graph or the sharp-backed
 * media module. A consumer such as Desktop's metadata-only bundle resolves a
 * model's protocols through it without dragging the session barrel in.
 */
import { createBuiltinCatalog } from '@wrenyard/providers';
import type { ModelDefinition, ProviderDefinition } from '@wrenyard/providers/base';
import { models as registeredModels, type ReasoningEffort } from '@wrenyard/models';

export { SESSION_PROTOCOLS, selectSessionProtocol, supportsSession } from '../transport/protocol.ts';
export type { SessionProtocol } from '../transport/protocol.ts';

/** Model facts used by the budget check and by the `<wy-info>` view. */
export interface ModelMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Route-owned reasoning levels this exact model can materialize. */
  reasoningEfforts?: readonly ReasoningEffort[];
  /** True only when the resolved definition declares the `image` capability. */
  imageInput?: boolean;
  /**
   * True only when the resolved provider opted out of the registered-canonical
   * metadata fallback. Its declared `maxOutputTokens` is then a capability, not
   * a mandatory per-request reservation, so the budget check resolves a request
   * output cap from the remaining room instead of reserving the whole maximum.
   */
  skipCanonicalMetadataFallback?: boolean;
}

/**
 * Upper bound on the output tokens one request reserves against its context
 * window. A model declaring a larger maximum still leaves the rest of the
 * window to input, so a huge declared maximum can never starve the budget.
 */
export const CONTEXT_OUTPUT_RESERVATION_CAP = 32_768;

/**
 * Output tokens one request reserves against its context window: the model's
 * declared maximum, bounded by {@link CONTEXT_OUTPUT_RESERVATION_CAP}. The same
 * value is what the context budget, the compaction threshold and the request's
 * own `max_tokens` use. Undefined when the model declares no maximum, so a
 * caller keeps skipping the reservation instead of inventing one.
 */
export function boundedOutputReservation(maxOutputTokens: number | undefined): number | undefined {
  if (maxOutputTokens === undefined) return undefined;
  return Math.min(maxOutputTokens, CONTEXT_OUTPUT_RESERVATION_CAP);
}

let catalog: ReturnType<typeof createBuiltinCatalog> | undefined;

function builtinCatalog(): ReturnType<typeof createBuiltinCatalog> {
  catalog ??= createBuiltinCatalog();
  return catalog;
}

/**
 * Model metadata for one `provider/model` public id. The built-in provider
 * catalog is authoritative; a field the provider module leaves undeclared is
 * completed from the canonical model in the `@wrenyard/models` registry. A
 * field neither source declares stays undefined, and the budget check is then
 * skipped instead of being invented.
 *
 * Metadata ownership is per field and per declaration: there is no
 * provider-wide suppression opt-out. A row that owns its upstream metadata is
 * authoritative for what it reports, so an omitted account context window or
 * output limit stays absent. The registered identity is read under the same
 * model id as the resolved offering.
 */
export function resolveModelMetadata(publicId: string, resolveProvider: (providerId: string) => ProviderDefinition | undefined = id => builtinCatalog().provider(id)): ModelMetadata {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return {};
  const providerId = publicId.slice(0, separator);
  const requestedModelId = publicId.slice(separator + 1);
  const provider = resolveProvider(providerId);
  const modelId = provider?.modelAliases?.[requestedModelId] ?? requestedModelId;
  const definition: ModelDefinition | undefined = provider?.models.find((entry) => entry.id === modelId);
  // One identity: the provider offering is resolved by (provider, registered
  // model id), and the registry defaults are read under that same id. A row
  // that owns its upstream metadata never regains a field its source omitted;
  // there is no separate canonical join and no metadata-suppression opt-out.
  const ownsMetadata = definition?.ownsMetadata === true;
  const defaults = ownsMetadata ? undefined : registeredModels.get(modelId)?.defaults;
  const contextWindow = definition?.contextWindow ?? defaults?.contextWindow;
  const maxOutputTokens = definition?.maxOutputTokens ?? defaults?.maxOutputTokens;
  // Reasoning levels are route-owned: only the resolved provider definition
  // declares them, and the canonical registry never carries an effort list.
  const reasoningEfforts = definition?.reasoningEfforts;
  const imageInput = definition?.capabilities?.some((capability) => capability === 'image');
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    ...(imageInput === undefined ? {} : { imageInput }),
    ...(ownsMetadata ? { skipCanonicalMetadataFallback: true } : {}),
  };
}
