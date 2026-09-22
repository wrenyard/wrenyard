import type { ClientDefinition, ModelDefinition, ProviderDefinition, ThinkingLevel } from '../base/index.ts';
import { resolveProviderModel, type CanonicalModelOverrides } from '../base/model-defaults.ts';
import { isMainstreamModelId, models } from '@wrenyard/models';
import {
  codeBuddyCanonicalModelId,
  productCreditsAreFree,
  type CodeBuddyProductModelEntry,
} from './product.ts';

/**
 * Product-file ids whose WY identity differs from the id (or the id with
 * `-ioa` stripped). Direct registry lookup remains the membership test;
 * similar names are never inferred.
 */
const CODEBUDDY_PRODUCT_MODEL_IDS: Readonly<Record<string, string>> = {
  'hy3': 'hunyuan-hy3',
  'hy3-ioa': 'hunyuan-hy3',
  'hy4-preview': 'hunyuan-hy4-preview',
  'hy4-preview-ioa': 'hunyuan-hy4-preview',
  'MiniMax-M3': 'minimax-m3',
  'MiniMax-M2.7': 'minimax-m2.7',
  'claude-haiku-4.5': 'claude-haiku-4-5',
  // CodeBuddy's 1M Claude rows publish the canonical Claude 5 identities; the
  // `-1m` spelling stays a provider-private wire id. The unsuffixed Sonnet 5 row
  // is the 200K window (server product config: maxInputTokens 200000), so it can
  // never claim claude-sonnet-5, while the unsuffixed Opus 5 row is itself 1M in
  // the same config (maxInputTokens 1000000, maxOutputTokens 128000) with no
  // `-1m` row beside it, so its own id is already the canonical identity.
  'claude-sonnet-5-1m': 'claude-sonnet-5',
  'claude-opus-5-1m': 'claude-opus-5',
  // DeepSeek V4 ships as `deepseek-v4-<tier>` in the plain/internal product
  // files and as `deepseek-v4-<tier>-ioa` in the iOA one; both channel forms
  // collapse onto the two unified registry identities.
  'deepseek-v4-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-flash-ioa': 'deepseek-v4.1-flash',
  'deepseek-v4-pro-ioa': 'deepseek-v4-pro',
};

/**
 * The only provider differences CodeBuddy has from the registered canonical
 * models it adopts *beyond* the selected product entry's own metadata: the
 * Claude family identity (which the registry does not record) and nothing else.
 * Context/output windows, image input and long-context support are taken from
 * the product entry itself (see productMetadataOverrides), so they are not
 * duplicated here. An adopted model with no entry is used verbatim from the
 * registry, and nothing is invented for an id this map does not name.
 */
const CODEBUDDY_MODEL_OVERRIDES: Readonly<Record<string, CanonicalModelOverrides>> = {
  'claude-haiku-4-5': { family: 'claude', claudeTier: 'haiku' },
  'claude-sonnet-5': { family: 'claude', claudeTier: 'sonnet' },
  'claude-opus-5': { family: 'claude', claudeTier: 'opus' },
};

const ONE_MILLION_TOKENS = 1_000_000;

/**
 * The product entry's own verified metadata, carried onto the adopted registry
 * model: the context and output windows the client actually enforces, the image
 * input the row declares, and long-context support derived solely from a row
 * that itself declares a 1M window. A row whose metadata says a short window
 * therefore never claims long-context support, and a row with no window
 * metadata keeps the registry's own.
 */
function productMetadataOverrides(entry: CodeBuddyProductModelEntry): CanonicalModelOverrides {
  const overrides: CanonicalModelOverrides = {};
  if (entry.maxInputTokens) overrides.contextWindow = entry.maxInputTokens;
  if (entry.maxOutputTokens) overrides.maxOutputTokens = entry.maxOutputTokens;
  if (entry.supportsImages === true) overrides.capabilities = ['text', 'image'];
  if (entry.maxInputTokens && entry.maxInputTokens >= ONE_MILLION_TOKENS) overrides.supports1MContext = true;
  return overrides;
}

/**
 * Historical observed wire spellings that keep canonicalizing onto the offering
 * they name. Inbound only: an entry here is never an outbound wire id, so a
 * spelling retired by the selected product file can never be routed to again.
 * Everything sent upstream is defined by the current product entries alone
 * (see buildCodeBuddyOfferings).
 */
const CODEBUDDY_HISTORICAL_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-v4.1-flash-ioa': 'deepseek-v4.1-flash',
  'deepseek-v4-pro-ioa': 'deepseek-v4-pro',
  'hy4-preview-ioa': 'hunyuan-hy4-preview',
  'hy3-ioa': 'hunyuan-hy3',
  'minimax-m3-ioa': 'minimax-m3',
};

const effortLadder = (levels: readonly ThinkingLevel[]): Readonly<Record<string, { effort: string }>> =>
  Object.fromEntries(levels.map((level) => [level, { effort: level }]));

export const codeBuddyClient: ClientDefinition = {
  id: 'codebuddy',
  nativeProvider: 'codebuddy',
  unsupportedGatewayProviders: ['opencode-go'],
  gatewayProtocols: ['openai_chat'],
  taskCapable: true,
};

// CodeBuddy publishes this unsuffixed id as a 200K model. It shares a spelling
// with the official 1M definition and must not be treated as the same model.
const SHORT_CONTEXT_CLAUDE_5 = new Set(['claude-sonnet-5']);

function lookupUnifiedModelId(productId: string): string | undefined {
  const mapped = CODEBUDDY_PRODUCT_MODEL_IDS[productId];
  if (mapped && models.get(mapped)) return mapped;
  const stripped = codeBuddyCanonicalModelId(productId);
  const strippedMapped = CODEBUDDY_PRODUCT_MODEL_IDS[stripped];
  if (strippedMapped && models.get(strippedMapped)) return strippedMapped;
  if (SHORT_CONTEXT_CLAUDE_5.has(productId) || SHORT_CONTEXT_CLAUDE_5.has(stripped)) return undefined;
  if (models.get(productId)) return productId;
  if (stripped !== productId && models.get(stripped)) return stripped;
  return undefined;
}

/** Map a product-file id onto a mainstream unified model, or ignore it. */
export function resolveCodeBuddyProductModelId(productId: string): string | undefined {
  const modelId = lookupUnifiedModelId(productId);
  if (!modelId || !isMainstreamModelId(modelId)) return undefined;
  return modelId;
}

/**
 * One product entry per canonical offering. Membership is product-driven: an
 * entry exists only where a product-file row resolves onto the unified registry.
 * When a product file lists both an unsuffixed row and its explicit `-1m`
 * variant — which resolve onto the same canonical model — the explicit variant
 * supplies the outbound wire spelling; the product order of every other row is
 * preserved.
 */
function preferredEntries(
  entries: readonly CodeBuddyProductModelEntry[],
): ReadonlyMap<string, CodeBuddyProductModelEntry> {
  const byOfferingId = new Map<string, CodeBuddyProductModelEntry>();
  for (const entry of entries) {
    const modelId = resolveCodeBuddyProductModelId(entry.id);
    if (!modelId) continue;
    const current = byOfferingId.get(modelId);
    if (current === undefined || (entry.id.endsWith('-1m') && !current.id.endsWith('-1m'))) {
      byOfferingId.set(modelId, entry);
    }
  }
  return byOfferingId;
}

/**
 * Historical upstream spellings canonicalize onto the offering they name, so
 * model-only statistics keep attributing an observed id after the product file
 * has moved on to a new wire id. Only a spelling whose target offering is
 * actually offered becomes an alias, so a retired identity is never resurrected
 * by the alias map alone.
 */
function historicalAliasesFor(offerings: readonly ModelDefinition[]): Record<string, string> {
  const offeringIds = new Set(offerings.map((entry) => entry.id));
  const aliases: Record<string, string> = {};
  for (const [observed, canonicalId] of Object.entries({ ...CODEBUDDY_PRODUCT_MODEL_IDS, ...CODEBUDDY_HISTORICAL_ALIASES })) {
    if (observed === canonicalId) continue;
    if (!offeringIds.has(canonicalId) || offeringIds.has(observed)) continue;
    aliases[observed] = canonicalId;
  }
  return aliases;
}

function thinkingMappingsFor(offerings: readonly ModelDefinition[]): NonNullable<ProviderDefinition['thinkingMappings']> {
  const mappings: Record<string, { codebuddy: ReturnType<typeof effortLadder> }> = {};
  for (const entry of offerings) {
    if (!entry.thinkingLevels?.length) continue;
    mappings[entry.id] = { codebuddy: effortLadder(entry.thinkingLevels) };
  }
  return mappings;
}

function aliasesFor(
  offerings: readonly ModelDefinition[],
  upstreamByCanonical: Readonly<Record<string, string>>,
): Record<string, string> {
  const modelIds = new Set(offerings.map((entry) => entry.id));
  const aliases: Record<string, string> = {};
  for (const [canonicalId, upstreamId] of Object.entries(upstreamByCanonical)) {
    if (canonicalId === upstreamId) continue;
    if (!modelIds.has(canonicalId) || modelIds.has(upstreamId)) continue;
    aliases[upstreamId] = canonicalId;
  }
  return aliases;
}

function buildCodeBuddyOfferings(productEntries: readonly CodeBuddyProductModelEntry[]): {
  models: ModelDefinition[];
  upstreamByCanonical: Record<string, string>;
} {
  const byOfferingId = new Map<string, ModelDefinition>();
  // Outbound wire ids come from the selected product entries alone — a mapping
  // exists exactly when the current product file names the row, including rows
  // whose id already is the offering id. Nothing is seeded, so no channel
  // spelling survives the product that declared it and no environment can be
  // routed to another environment's spelling.
  const upstreamByCanonical: Record<string, string> = {};

  // Membership is product-driven and the offering IS the canonical registry
  // model: an entry exists only when a product-file row resolves onto the
  // unified registry, and it is then decorated by the row's own metadata plus
  // the compact difference map alone. No rename layer exists, and no offering is
  // manufactured from a name.
  for (const [modelId, entry] of preferredEntries(productEntries)) {
    const overrides: CanonicalModelOverrides = { ...productMetadataOverrides(entry), ...CODEBUDDY_MODEL_OVERRIDES[modelId] };
    const resolved = resolveProviderModel({ canonical: modelId, overrides });
    byOfferingId.set(
      modelId,
      productCreditsAreFree(entry.credits) ? { ...resolved, free: true } : resolved,
    );
    // The product-file id is the wire spelling — including the identity rows,
    // where the offering is already spelled the way the product names it.
    upstreamByCanonical[modelId] = entry.id;
  }

  return { models: [...byOfferingId.values()], upstreamByCanonical };
}

export function createCodeBuddyModels(entries: readonly CodeBuddyProductModelEntry[]) {
  const built = buildCodeBuddyOfferings(entries);
  const upstreamModels: Readonly<Record<string, string>> = Object.freeze(built.upstreamByCanonical);
  const definition: Omit<ProviderDefinition, 'models'> & { models: readonly ModelDefinition[] } = {
    id: 'codebuddy',
    displayName: 'CodeBuddy',
    description: 'CodeBuddy 提供的 DeepSeek、混元与 Kimi 模型。',
    setupHint: '请在 CodeBuddy 客户端完成登录，返回啾啾工坊后刷新状态。',
    credentialResolver: 'codebuddy',
    nativeClients: ['codebuddy'],
    defaultModel: 'hunyuan-hy4-preview',
    useClientBinary: true,
    models: built.models,
    // Aliases only target currently offered models, including when the product
    // snapshot is absent. Outbound wire ids come from the selected product.
    modelAliases: {
      ...historicalAliasesFor(built.models),
      ...aliasesFor(built.models, upstreamModels),
    },
    thinkingMappings: thinkingMappingsFor(built.models),
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://copilot.tencent.com/v2/chat/completions', authScheme: 'bearer' }],
  };

  return { definition, upstreamModels };
}

export type CodeBuddyModels = ReturnType<typeof createCodeBuddyModels>;
