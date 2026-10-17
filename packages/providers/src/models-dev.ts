import { anthropic, defineProvider, openAI } from './base/model-defaults.ts';
import { type ProtocolCapability, type ProviderDefinition } from './base/index.ts';
import {
  MODELS_DEV_CATALOG_PROVIDERS,
  MODELS_DEV_CATALOG_SOURCE,
  type ModelsDevCatalogModel,
  type ModelsDevCatalogProvider,
} from './models-dev-catalog.generated.ts';

export { MODELS_DEV_CATALOG_SOURCE };

/**
 * The exact public endpoint for a catalog row: its fixed HTTPS base URL plus the
 * one protocol path, with trailing slashes trimmed so a single separator joins
 * them. Anthropic rows authenticate with `x-api-key`; OpenAI rows carry a bearer
 * token. Rows whose base is not fixed/public are not present in the snapshot.
 */
function protocolFor(entry: ModelsDevCatalogProvider): ProtocolCapability {
  const base = entry.baseUrl.replace(/\/+$/, '');
  switch (entry.protocol) {
    case 'anthropic_messages':
      return anthropic(`${base}/messages`, 'x-api-key');
    case 'openai_responses':
      return { protocol: 'openai_responses', endpoint: `${base}/responses`, authScheme: 'bearer' };
    case 'openai_chat':
      return openAI(`${base}/chat/completions`, 'bearer');
  }
}

/**
 * One route model built from a catalog row: the row adopts its registered
 * canonical identity as the public offering id, and the exact upstream wire id
 * becomes a private `upstreamId` binding that `defineProvider` turns into the
 * protocol `upstreamModels` table. The row owns its upstream metadata: only the
 * metadata the source actually supplies is attached (numeric context/output
 * limits, input-modality capabilities and a complete, flat
 * [cached, input, output] price), and a missing or tiered value stays absent
 * instead of regaining an unrelated registry default. Speed and intelligence
 * always come from that identity.
 */
function modelFor(source: ModelsDevCatalogModel) {
  return {
    id: source.canonicalId,
    displayName: source.displayName,
    ownsMetadata: true,
    ...(source.id === source.canonicalId ? {} : { upstreamId: source.id }),
    ...(source.contextWindow !== undefined ? { contextWindow: source.contextWindow } : {}),
    ...(source.maxOutputTokens !== undefined
      ? { maxTokens: source.maxOutputTokens, maxOutputTokens: source.maxOutputTokens }
      : {}),
    ...(source.capabilities !== undefined ? { capabilities: source.capabilities } : {}),
    ...(source.pricing !== undefined ? { pricing: source.pricing } : {}),
  };
}

/**
 * Wrenyard publishes the models.dev `xai` source row under its canonical
 * SpaceXAI naming as the public provider id `spacex-ai-api`, so it stays
 * distinct from the existing native `spacex-ai` builtin (Grok OAuth / native
 * client), which this generic API-key row does not replace. Every other row
 * keeps its source-exact id and display name.
 */
function publicProviderIdentity(
  entry: ModelsDevCatalogProvider,
): { readonly id: string; readonly displayName: string } {
  return entry.sourceId === 'xai'
    ? { id: 'spacex-ai-api', displayName: 'SpaceXAI API' }
    : { id: entry.id, displayName: entry.displayName };
}

/**
 * One managed-API-key definition per models.dev catalog row. This is checked-in
 * static data: there is no runtime catalog fetch, no new auth mechanism and no
 * per-provider special case beyond the single `xai` identity mapping above.
 *
 * `usesProviderDefaultReasoning` is the provider-level opt-in to the single
 * provider-default sentinel ladder: the snapshot declares no reasoning ladder
 * for any row, so every route is materialized with the singleton `['default']`
 * ladder instead of an empty one. That is a truthful provider-level setting —
 * the route has no selectable weak-to-strong ladder, and the default level asks
 * the upstream to use its own behaviour. `convertReasoningEffort` materializes
 * no upstream reasoning field for it: neither `none` nor a fabricated effort.
 */
export const modelsDevProviders: readonly ProviderDefinition[] = MODELS_DEV_CATALOG_PROVIDERS.map(
  (entry) => {
    const identity = publicProviderIdentity(entry);
    return defineProvider({
      id: identity.id,
      displayName: identity.displayName,
      credentialResolver: 'managed',
      models: entry.models.map(modelFor),
      protocols: [protocolFor(entry)],
      usesProviderDefaultReasoning: true,
      // The provider default sends no upstream reasoning fields at all: it is
      // neither `none` nor a fabricated effort.
      convertReasoningEffort: () => ({}),
    });
  },
);
