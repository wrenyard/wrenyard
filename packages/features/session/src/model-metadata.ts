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

export { SESSION_PROTOCOLS, selectSessionProtocol, supportsSession } from './transport/protocol.ts';
export type { SessionProtocol } from './transport/protocol.ts';

/** Model facts used by the budget check and by the `<wy-info>` view. */
export interface ModelMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Route-owned reasoning levels this exact model can materialize. */
  reasoningEfforts?: readonly ReasoningEffort[];
  /** True only when the resolved definition declares the `image` capability. */
  imageInput?: boolean;
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
 */
export function resolveModelMetadata(publicId: string, resolveProvider: (providerId: string) => ProviderDefinition | undefined = id => builtinCatalog().provider(id)): ModelMetadata {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return {};
  const providerId = publicId.slice(0, separator);
  const requestedModelId = publicId.slice(separator + 1);
  const provider = resolveProvider(providerId);
  const modelId = provider?.modelAliases?.[requestedModelId] ?? requestedModelId;
  const definition: ModelDefinition | undefined = provider?.models.find((entry) => entry.id === modelId);
  const defaults = registeredModels.get(definition?.canonicalModel?.id ?? modelId)?.defaults;
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
  };
}
