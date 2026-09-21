import type { Catalog, ClientDefinition, DispatchPlan, ProviderDefinition } from './base/catalog.ts';
import { codeBuddy, builtinDefinitions } from './builtins.ts';

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
  { id: 'dsh', unsupportedGatewayProviders: ['opencode-go'], gatewayProtocols: ['openai_chat'] },
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
  { id: 'opencode', nativeProvider: 'opencode-zen', gatewayProtocols: ['openai_chat', 'anthropic_messages'], taskCapable: true },
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

export function canonicalizeBuiltinPublicModelId(publicId: string): string {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return publicId;
  const providerId = publicId.slice(0, separator);
  const modelId = publicId.slice(separator + 1);
  const provider = BUILTIN_PROVIDERS.find((candidate) => candidate.id === providerId);
  const canonicalModelId = provider?.modelAliases?.[modelId];
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
