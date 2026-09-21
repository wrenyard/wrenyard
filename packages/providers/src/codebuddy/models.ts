import type {
  CanonicalModelDefinition,
  ClientDefinition,
  IntelligenceTier,
  ModelCapability,
  ModelDefinition,
  ModelPricing,
  ProviderDefinition,
  ThinkingLevel,
} from '@wrenyard/catalog';
import {
  isMainstreamModelId,
  models,
  THINKING_LOW_HIGH_MAX,
  type ModelDefaults,
  type RegisteredModel,
} from '@wrenyard/models';
import { builtinModelDisplayNameIfKnown } from '../model-display-names.ts';
import {
  codeBuddyCanonicalModelId,
  loadInstalledCodeBuddyProductModels,
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
};

/**
 * Channel overlay after the mainstream JSON match. Used as overrides when the
 * product file lists the same model, and as extra offerings when it does not.
 */
const CODEBUDDY_CUSTOM_MODELS: readonly CodeBuddyCustomModel[] = [
  {
    id: 'deepseek-v4.1-flash',
    modelId: 'deepseek-v4.1-flash',
    overrides: {
      contextWindow: 1_000_000,
      maxTokens: 50_000,
      thinkingLevels: THINKING_LOW_HIGH_MAX,
      capabilities: ['text', 'image'],
      speed: 201,
    },
  },
  {
    id: 'hy4-preview',
    modelId: 'hunyuan-hy4-preview',
    free: true,
    projectCanonical: true,
    overrides: { speed: 38, intelligence: 'mid', capabilities: ['text'] },
  },
  {
    id: 'hy3',
    modelId: 'hunyuan-hy3',
    free: true,
    overrides: { speed: 94, intelligence: 'low', capabilities: ['text'] },
  },
  {
    id: 'minimax-m3',
    modelId: 'minimax-m3',
    projectCanonical: true,
    overrides: { speed: 156, intelligence: 'low', capabilities: ['text'] },
  },
  {
    id: 'kimi-k3',
    modelId: 'kimi-k3',
    projectCanonical: true,
    overrides: {
      thinkingLevels: THINKING_LOW_HIGH_MAX,
      capabilities: ['text', 'image'],
      intelligence: 'high',
      speed: 40,
    },
  },
  {
    id: 'glm-5.3',
    modelId: 'glm-5.3',
    projectCanonical: true,
    overrides: { intelligence: 'high', capabilities: ['text'], speed: 64 },
  },
  {
    id: 'glm-5.3-flash',
    modelId: 'glm-5.3-flash',
    projectCanonical: true,
    overrides: { intelligence: 'mid', capabilities: ['text'], speed: 73 },
  },
];

const CUSTOM_IOA_UPSTREAM: Readonly<Record<string, string>> = {
  'deepseek-v4.1-flash': 'deepseek-v4.1-flash-ioa',
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

function lookupUnifiedModelId(productId: string): string | undefined {
  const mapped = CODEBUDDY_PRODUCT_MODEL_IDS[productId];
  if (mapped && models.get(mapped)) return mapped;
  const stripped = codeBuddyCanonicalModelId(productId);
  const strippedMapped = CODEBUDDY_PRODUCT_MODEL_IDS[stripped];
  if (strippedMapped && models.get(strippedMapped)) return strippedMapped;
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
        displayName: builtinModelDisplayNameIfKnown(registered.id) ?? registered.displayName,
      }
    : undefined;
  return {
    id: offeringId,
    displayName: builtinModelDisplayNameIfKnown(offeringId) ?? registered.displayName,
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
  const matchedModelIds = new Set<string>();
  const upstreamByCanonical: Record<string, string> = { ...CUSTOM_IOA_UPSTREAM };

  for (const entry of productEntries) {
    const modelId = resolveCodeBuddyProductModelId(entry.id);
    if (!modelId) continue;
    const registered = models.get(modelId);
    if (!registered) continue;
    const custom = customForModelId(modelId);
    const offeringId = custom?.id ?? codeBuddyCanonicalModelId(entry.id);
    if (byOfferingId.has(offeringId)) continue;
    byOfferingId.set(offeringId, offeringFromRegistered(offeringId, registered, custom, entry));
    matchedModelIds.add(modelId);
    if (entry.id !== offeringId) upstreamByCanonical[offeringId] = entry.id;
  }

  for (const custom of CODEBUDDY_CUSTOM_MODELS) {
    if (matchedModelIds.has(custom.modelId) || byOfferingId.has(custom.id)) continue;
    const registered = models.require(custom.modelId);
    byOfferingId.set(custom.id, offeringFromRegistered(custom.id, registered, custom));
  }

  return { models: [...byOfferingId.values()], upstreamByCanonical };
}

const installedProduct = loadInstalledCodeBuddyProductModels();
const built = buildCodeBuddyOfferings(installedProduct.entries);

export const CODEBUDDY_IOA_UPSTREAM_MODELS: Readonly<Record<string, string>> = Object.freeze(
  built.upstreamByCanonical,
);

export const codeBuddyProvider: Omit<ProviderDefinition, 'models'> & { models: readonly CodeBuddyModel[] } = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  credentialResolver: 'codebuddy',
  nativeClients: ['codebuddy'],
  defaultModel: 'deepseek-v4.1-flash',
  useClientBinary: true,
  models: built.models,
  modelAliases: aliasesFor(built.models, CODEBUDDY_IOA_UPSTREAM_MODELS),
  thinkingMappings: thinkingMappingsFor(built.models),
  protocols: [{ protocol: 'openai_chat', endpoint: 'https://copilot.tencent.com/v2/chat/completions', authScheme: 'bearer' }],
};

export const CODEBUDDY_FREE_MODEL_IDS: ReadonlySet<string> = new Set(
  codeBuddyProvider.models.filter((entry) => entry.free === true).map((entry) => entry.id),
);
