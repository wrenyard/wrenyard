import type { ProviderDefinition } from '../base/index.ts';
import type {
  CanonicalModelDefinition,
  ClientDefinition,
  IntelligenceTier,
  ModelCapability,
  ModelDefinition,
  ModelPricing,
  ThinkingLevel,
} from '../base/index.ts';
import {
  isMainstreamModelId,
  models,
  type ModelDefaults,
  type RegisteredModel,
} from '@wrenyard/models';
import {
  codeBuddyCanonicalModelId,
  productCreditsAreFree,
  type CodeBuddyProductModelEntry,
} from './product.ts';

type CodeBuddyModel = Omit<ModelDefinition, 'speed' | 'intelligence' | 'pricing'> & {
  speed: number;
  intelligence: IntelligenceTier;
  capabilities: readonly ModelCapability[];
  pricing: ModelPricing;
};

interface ModelOverrides {
  intelligence?: IntelligenceTier;
  capabilities?: readonly ModelCapability[];
  thinkingLevels?: readonly ThinkingLevel[];
  contextWindow?: number;
  maxTokens?: number;
  pricing?: ModelPricing;
  speed?: number;
}

interface CodeBuddyCustomModel {
  id: string;
  modelId: string;
  free?: boolean;
  projectCanonical?: boolean;
  overrides?: ModelOverrides;
}

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
  // CodeBuddy's unsuffixed Claude 5 ids are the 200K windows. The 1M rows are
  // the same models as the official Sonnet 5 and Opus 5 definitions.
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
 * Channel overlay after the mainstream JSON match. Only decorates an offering
 * the product file already matched; it never manufactures offerings by itself.
 */
const CODEBUDDY_CUSTOM_MODELS: readonly CodeBuddyCustomModel[] = [
  {
    id: 'deepseek-v4.1-flash',
    modelId: 'deepseek-v4.1-flash',
  },
  {
    // The unified registry already supplies Pro's tier, capability set, thinking
    // ladder, pricing and speed; only the product-file context/output metadata
    // is carried across as an override.
    id: 'deepseek-v4-pro',
    modelId: 'deepseek-v4-pro',
    overrides: {
      contextWindow: 1_000_000,
      maxTokens: 50_000,
    },
  },
  {
    id: 'hy4-preview',
    modelId: 'hunyuan-hy4-preview',
    free: true,
    projectCanonical: true,
  },
  {
    id: 'hy3',
    modelId: 'hunyuan-hy3',
    free: true,
    projectCanonical: true,
  },
  {
    id: 'minimax-m3',
    modelId: 'minimax-m3',
    projectCanonical: true,
  },
  {
    id: 'kimi-k3',
    modelId: 'kimi-k3',
    projectCanonical: true,
  },
  {
    id: 'glm-5.3',
    modelId: 'glm-5.3',
    projectCanonical: true,
  },
  {
    id: 'glm-5.3-flash',
    modelId: 'glm-5.3-flash',
    projectCanonical: true,
  },
  {
    id: 'claude-sonnet-5-1m',
    modelId: 'claude-sonnet-5',
    projectCanonical: true,
    overrides: { contextWindow: 1_000_000, maxTokens: 128_000, capabilities: ['text', 'image'] },
  },
  {
    id: 'claude-opus-5-1m',
    modelId: 'claude-opus-5',
    projectCanonical: true,
    overrides: { contextWindow: 1_000_000, capabilities: ['text', 'image'] },
  },
];

/** Confirmed iOA wire ids. */
const CUSTOM_IOA_UPSTREAM: Readonly<Record<string, string>> = {
  'deepseek-v4.1-flash': 'deepseek-v4.1-flash-ioa',
  'deepseek-v4-pro': 'deepseek-v4-pro-ioa',
  'hy4-preview': 'hy4-preview-ioa',
  'hy3': 'hy3-ioa',
  'minimax-m3': 'minimax-m3-ioa',
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

// CodeBuddy publishes these exact ids as 200K models. They share a spelling
// with the official 1M definitions and must not be treated as the same model.
const SHORT_CONTEXT_CLAUDE_5 = new Set(['claude-sonnet-5', 'claude-opus-5']);

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

function customForModelId(modelId: string): CodeBuddyCustomModel | undefined {
  return CODEBUDDY_CUSTOM_MODELS.find((entry) => entry.modelId === modelId);
}

function pickDefault<T>(override: T | undefined, fallback: T | undefined): T | undefined {
  return override !== undefined ? override : fallback;
}

function offeringFromRegistered(
  offeringId: string,
  registered: RegisteredModel,
  custom: CodeBuddyCustomModel | undefined,
  product?: CodeBuddyProductModelEntry,
): CodeBuddyModel {
  const defaults: ModelDefaults = registered.defaults;
  const overrides = custom?.overrides;
  const thinkingLevels = pickDefault(overrides?.thinkingLevels, defaults.thinkingLevels);
  const contextWindow = pickDefault(overrides?.contextWindow, defaults.contextWindow);
  const maxTokens = pickDefault(overrides?.maxTokens, defaults.maxOutputTokens);
  const canonicalModel: CanonicalModelDefinition | undefined = custom?.projectCanonical === true
    ? {
        id: registered.id,
        displayName: registered.displayName,
      }
    : undefined;
  return {
    id: offeringId,
    displayName: registered.displayName,
    intelligence: overrides?.intelligence ?? defaults.intelligence,
    capabilities: overrides?.capabilities ?? defaults.capabilities,
    pricing: overrides?.pricing ?? defaults.pricing,
    speed: overrides?.speed ?? defaults.speed,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(thinkingLevels ? { thinkingLevels } : {}),
    ...(canonicalModel ? { canonicalModel } : {}),
    ...(custom?.free === true || productCreditsAreFree(product?.credits) ? { free: true } : {}),
  };
}

/**
 * Historical upstream spellings canonicalize onto the offering they name, so
 * model-only statistics keep attributing an observed id after the product file
 * has moved on to a new wire id. This is independent of current membership:
 * it is derived from the identity map, not from which entries are offered.
 */
function historicalAliasesFor(offerings: readonly CodeBuddyModel[]): Record<string, string> {
  const offeringIds = new Set(offerings.map((entry) => entry.id));
  const aliases: Record<string, string> = {};
  for (const [observed, unifiedId] of Object.entries(CODEBUDDY_PRODUCT_MODEL_IDS)) {
    const target = customForModelId(unifiedId)?.id ?? unifiedId;
    if (observed === target) continue;
    if (!offeringIds.has(target) || offeringIds.has(observed)) continue;
    aliases[observed] = target;
  }
  return aliases;
}

function thinkingMappingsFor(offerings: readonly CodeBuddyModel[]): NonNullable<ProviderDefinition['thinkingMappings']> {
  const mappings: Record<string, { codebuddy: ReturnType<typeof effortLadder> }> = {};
  for (const entry of offerings) {
    if (!entry.thinkingLevels?.length) continue;
    mappings[entry.id] = { codebuddy: effortLadder(entry.thinkingLevels) };
  }
  return mappings;
}

function aliasesFor(
  offerings: readonly CodeBuddyModel[],
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
  models: CodeBuddyModel[];
  upstreamByCanonical: Record<string, string>;
} {
  const byOfferingId = new Map<string, CodeBuddyModel>();
  // Confirmed product wire ids seed the map up front, so observed spellings keep
  // canonicalizing even when the current product file stops listing them.
  const upstreamByCanonical: Record<string, string> = { ...CUSTOM_IOA_UPSTREAM };

  // Membership is product-driven: an offering exists only when a product-file
  // entry resolves onto the unified registry. The channel overlay never
  // manufactures offerings on its own — it only decorates a matched entry.
  for (const entry of productEntries) {
    const modelId = resolveCodeBuddyProductModelId(entry.id);
    if (!modelId) continue;
    const registered = models.get(modelId);
    if (!registered) continue;
    const custom = customForModelId(modelId);
    const offeringId = custom?.id ?? codeBuddyCanonicalModelId(entry.id);
    if (byOfferingId.has(offeringId)) continue;
    byOfferingId.set(offeringId, offeringFromRegistered(offeringId, registered, custom, entry));
    // The product-file id is the wire spelling when it differs from the offering.
    if (entry.id !== offeringId) upstreamByCanonical[offeringId] = entry.id;
  }

  return { models: [...byOfferingId.values()], upstreamByCanonical };
}

export function createCodeBuddyModels(entries: readonly CodeBuddyProductModelEntry[]) {
  const built = buildCodeBuddyOfferings(entries);
  const upstreamModels: Readonly<Record<string, string>> = Object.freeze(built.upstreamByCanonical);
  const definition: Omit<ProviderDefinition, 'models'> & { models: readonly CodeBuddyModel[] } = {
    id: 'codebuddy',
    displayName: 'CodeBuddy',
    description: 'CodeBuddy 提供的 DeepSeek、混元与 Kimi 模型。',
    setupHint: '请在 CodeBuddy 客户端完成登录，返回啾啾工坊后刷新状态。',
    credentialResolver: 'codebuddy',
    nativeClients: ['codebuddy'],
    defaultModel: 'deepseek-v4.1-flash',
    useClientBinary: true,
    models: built.models,
    modelAliases: { ...historicalAliasesFor(built.models), ...aliasesFor(built.models, upstreamModels) },
    thinkingMappings: thinkingMappingsFor(built.models),
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://copilot.tencent.com/v2/chat/completions', authScheme: 'bearer' }],
  };

  return { definition, upstreamModels };
}

export type CodeBuddyModels = ReturnType<typeof createCodeBuddyModels>;
