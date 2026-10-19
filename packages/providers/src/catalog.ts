import type { Catalog, ClientDefinition, DispatchPlan, ProviderDefinition } from './base/catalog.ts';
import { codeBuddy, builtinDefinitions, providerImplementations } from './builtins.ts';

export const BUILTIN_CLIENTS: readonly ClientDefinition[] = [
  // Native WebSearch is documented at https://code.claude.com/docs/en/tools-reference
  // (checked 2026-09-10); native-capable only against its exact nativeProvider.
  { id: 'claude', nativeProvider: 'claude-coding', gatewayProtocols: ['anthropic_messages'], taskCapable: true, supportsNativeWebSearch: true },
  ...codeBuddy.clients,
  // Codex --search is live per https://learn.chatgpt.com/docs/web-search?surface=cli
  // (checked 2026-09-10); custom/third-party providers are not implicitly supported.
  { id: 'codex', nativeProvider: 'chatgpt', gatewayProtocols: ['openai_responses'], taskCapable: true, supportsNativeWebSearch: true },
  // Cursor CLI gained WebSearch/WebFetch per https://cursor.com/changelog/cli-jan-16-2026
  // (checked 2026-09-10).
  { id: 'cursor', nativeProvider: 'cursor', unsupportedGatewayProviders: ['opencode-go'], gatewayProtocols: ['openai_chat'], taskCapable: true, supportsNativeWebSearch: true },
  { id: 'dsh', forwardsGatewayReasoningEffort: true, unsupportedGatewayProviders: ['opencode-go'], gatewayProtocols: ['openai_chat'] },
  {
    id: 'grok',
    nativeProvider: 'spacex-ai',
    gatewayProtocols: ['openai_chat'],
    unsupportedGatewayProviders: ['codebuddy', 'opencode-go'],
    taskCapable: true,
    // Client web_search with backend support per https://docs.x.ai/build/settings
    // (checked 2026-09-10); our Grok gateway projection stays SupportsBackendSearch=false.
    supportsNativeWebSearch: true,
  },
  { id: 'opencode', forwardsGatewayReasoningEffort: true, nativeProvider: 'opencode-zen', gatewayProtocols: ['openai_chat', 'anthropic_messages'], taskCapable: true },
];

/**
 * Shared provider-level gateway boundary for built-in clients. Protocol
 * compatibility is evaluated separately; this helper carries only known
 * execution restrictions that protocol metadata cannot express.
 */
export function isBuiltinClientGatewayProviderSupported(clientID: string, providerID: string): boolean {
  const client = BUILTIN_CLIENTS.find((candidate) => candidate.id === clientID);
  return client !== undefined && !client.unsupportedGatewayProviders?.includes(providerID);
}

export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = builtinDefinitions;

/** True when the provider declares that the model's stream is a replay, so its timing is not a speed. */
export function hasReplayedStream(providerId: string, modelId: string): boolean {
  return BUILTIN_PROVIDERS.find((provider) => provider.id === providerId)?.replayedStreamModels?.includes(modelId) === true;
}

/**
 * Verified historical identity migration for one provider.
 *
 * A persisted or observed spelling resolves only through facts this provider
 * declares: its registered offering ids, each offering's private upstream
 * binding, explicit model aliases, and exact reasoning-effort mapping UIDs. The
 * result is accepted only when exactly one registered offering matches, so an
 * unknown or ambiguous spelling returns `undefined` instead of an invented
 * identity. There is no family, sibling, suffix or declaration-order inference,
 * and the provider stays the caller's scope: a qualified `provider/model` input
 * is accepted only for the same provider.
 *
 * `activeDefinition` is the live provider definition when the caller already
 * holds one (for example `catalog.provider(id)` or a provider implementation's
 * current `.definition`). When supplied it is the authority for offered ids,
 * upstream bindings, aliases and effort UIDs, so a dynamically discovered
 * Devin/OpenCode Zen catalog is matched instead of a static seed.
 */
export function resolveHistoricalOfferedModelId(
  provider: ProviderDefinition,
  spelling: string,
  activeDefinition?: ProviderDefinition,
): string | undefined {
  const definition = activeDefinition ?? provider;
  if (typeof spelling !== 'string') return undefined;
  const requested = spelling.trim();
  if (requested === '') return undefined;
  const prefix = `${definition.id}/`;
  const model = requested.startsWith(prefix) ? requested.slice(prefix.length) : requested;
  if (model === '') return undefined;
  const offered = new Set(definition.models.map((entry) => entry.id));
  // An already-registered id is the idempotent answer.
  if (offered.has(model)) return model;
  const matches = new Set<string>();
  const accept = (candidate: string | undefined): void => {
    if (candidate !== undefined && offered.has(candidate)) matches.add(candidate);
  };
  accept(definition.modelAliases?.[model]);
  for (const entry of definition.models) {
    if (entry.upstreamId === model) accept(entry.id);
  }
  for (const [canonical, clients] of Object.entries(definition.reasoningEffortMappings ?? {})) {
    for (const levels of Object.values(clients)) {
      for (const mapping of Object.values(levels)) {
        if (mapping?.model === model) accept(canonical);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

/**
 * Provider-id lookup of {@link resolveHistoricalOfferedModelId}. The live
 * provider implementation definition (dynamic Devin/OpenCode Zen discovery) is
 * preferred, and the static builtin list is only the fallback for a provider
 * that has no runtime implementation. An explicit `activeDefinition` always
 * wins over both.
 */
export function resolveHistoricalProviderModelId(
  providerId: string,
  spelling: string,
  activeDefinition?: ProviderDefinition,
): string | undefined {
  if (typeof providerId !== 'string') return undefined;
  const id = providerId.trim();
  if (id === '') return undefined;
  const provider = activeDefinition
    ?? providerImplementations.get(id)?.definition
    ?? BUILTIN_PROVIDERS.find((candidate) => candidate.id === id);
  return provider === undefined ? undefined : resolveHistoricalOfferedModelId(provider, spelling);
}

/**
 * Historical read-only identity migration. A selection persisted before the
 * public identity became the registered id still names `provider/model`; this
 * normalizes it onto the registered id of that provider through the verified
 * unique-match resolver above. It never invents an identity and never accepts a
 * wire alias in a NEW request — a bare registered id is returned unchanged, and
 * an unknown or ambiguous spelling keeps its own text.
 */
export function canonicalizeBuiltinPublicModelId(publicId: string): string {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return publicId;
  const providerId = publicId.slice(0, separator);
  const provider = BUILTIN_PROVIDERS.find((candidate) => candidate.id === providerId);
  if (!provider) return publicId;
  const canonicalModelId = resolveHistoricalOfferedModelId(provider, publicId.slice(separator + 1));
  return canonicalModelId ? `${providerId}/${canonicalModelId}` : publicId;
}

// Derive logical task dispatch plans solely from Catalog compatibility and
// task-capable client metadata. Keys are canonical provider/model:client targets
// (formatRunSyntax); no source preset table, seed, profile aliases, or policy
// registry exists in this file.
export function deriveTaskDispatchPlans(catalog: Catalog): Readonly<Record<string, DispatchPlan>> {
  return Object.fromEntries(catalog.enumerateTaskCandidates().map((candidate) => [
    candidate.profileId,
    catalog.resolveRun(candidate.client, candidate.provider, candidate.model),
  ]));
}
