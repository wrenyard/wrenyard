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
import { builtinModelDisplayName, type BuiltinModelId } from '../model-display-names.ts';

const SRC_DEEPSEEK = 'https://api-docs.deepseek.com/quick_start/pricing/';
const SRC_TENCENT_HY = 'https://intl.cloud.tencent.com/zh/document/product/1300/78937';
const SRC_TENCENT_TOKENHUB = 'https://cloud.tencent.com/document/product/1823/130055';
const SRC_KIMI = 'https://www.kimi.com/en/blog/kimi-k3';
const SRC_ZAI = 'https://docs.z.ai/guides/overview/pricing';
const DEFAULT_CHECKED_AT = '2026-09-05';

const THINKING_LOW_HIGH_MAX: readonly ThinkingLevel[] = ['low', 'high', 'max'];

const REFERENCE_DEEPSEEK_FLASH_OFF_PEAK: ModelPricing = {
  inputUsdPerMillion: 0.15,
  cachedInputUsdPerMillion: 0.003,
  outputUsdPerMillion: 0.6,
  source: 'wrenyard:reference-deepseek-v4.1-flash-off-peak',
  checkedAt: '2026-09-17',
};

const effortLadder = (levels: readonly ThinkingLevel[]): Readonly<Record<string, { effort: string }>> =>
  Object.fromEntries(levels.map((level) => [level, { effort: level }]));

const canonical = (id: BuiltinModelId): CanonicalModelDefinition => ({
  id,
  displayName: builtinModelDisplayName(id),
});

type CodeBuddyModel = Omit<ModelDefinition, 'speed' | 'intelligence' | 'pricing'> & {
  speed: number;
  intelligence: IntelligenceTier;
  capabilities: readonly ModelCapability[];
  pricing: ModelPricing;
};

function model(
  id: BuiltinModelId,
  options: {
    contextWindow?: number;
    maxTokens?: number;
    canonicalModel?: CanonicalModelDefinition;
    thinkingLevels?: readonly ThinkingLevel[];
    free?: boolean;
    intelligence: IntelligenceTier;
    capabilities: readonly ModelCapability[];
    pricing: ModelPricing;
    speed: number;
  },
): CodeBuddyModel {
  return {
    id,
    displayName: builtinModelDisplayName(id),
    intelligence: options.intelligence,
    capabilities: options.capabilities,
    pricing: options.pricing,
    speed: options.speed,
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(options.canonicalModel ? { canonicalModel: options.canonicalModel } : {}),
    ...(options.thinkingLevels ? { thinkingLevels: options.thinkingLevels } : {}),
    ...(options.free ? { free: true } : {}),
  };
}

export const codeBuddyClient: ClientDefinition = {
  id: 'codebuddy',
  nativeProvider: 'codebuddy',
  unsupportedGatewayProviders: ['opencode-go'],
  gatewayProtocols: ['openai_chat'],
  taskCapable: true,
};

export const codeBuddyProvider: Omit<ProviderDefinition, 'models'> & { models: readonly CodeBuddyModel[] } = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  credentialResolver: 'codebuddy',
  nativeClients: ['codebuddy'],
  defaultModel: 'deepseek-v4.1-flash',
  useClientBinary: true,
  models: [
    model('deepseek-v4.1-flash', {
      contextWindow: 1_000_000,
      maxTokens: 50_000,
      thinkingLevels: THINKING_LOW_HIGH_MAX,
      intelligence: 'mid',
      capabilities: ['text', 'image'],
      pricing: {
        inputUsdPerMillion: 0.3,
        cachedInputUsdPerMillion: 0.006,
        outputUsdPerMillion: 1.2,
        source: SRC_DEEPSEEK,
        checkedAt: '2026-09-10',
      },
      speed: 200.5,
    }),
    model('hy4-preview', {
      canonicalModel: canonical('hunyuan-hy4-preview'),
      free: true,
      intelligence: 'mid',
      capabilities: ['text'],
      pricing: {
        inputUsdPerMillion: 0.834,
        cachedInputUsdPerMillion: 0.042,
        outputUsdPerMillion: 2.501,
        source: SRC_TENCENT_HY,
        checkedAt: DEFAULT_CHECKED_AT,
      },
      speed: 38,
    }),
    model('hy3', {
      free: true,
      intelligence: 'low',
      capabilities: ['text'],
      pricing: {
        inputUsdPerMillion: 0.139,
        cachedInputUsdPerMillion: 0.035,
        outputUsdPerMillion: 0.556,
        source: SRC_TENCENT_TOKENHUB,
        checkedAt: '2026-09-08',
      },
      speed: 93.8,
    }),
    model('minimax-m3', {
      canonicalModel: canonical('minimax-m3'),
      intelligence: 'low',
      capabilities: ['text'],
      pricing: REFERENCE_DEEPSEEK_FLASH_OFF_PEAK,
      speed: 155.5,
    }),
    model('kimi-k3', {
      canonicalModel: canonical('kimi-k3'),
      thinkingLevels: THINKING_LOW_HIGH_MAX,
      intelligence: 'high',
      capabilities: ['text', 'image'],
      pricing: {
        inputUsdPerMillion: 3,
        cachedInputUsdPerMillion: 0.30,
        outputUsdPerMillion: 15,
        source: SRC_KIMI,
        checkedAt: DEFAULT_CHECKED_AT,
      },
      speed: 39.7,
    }),
    model('glm-5.3', {
      canonicalModel: canonical('glm-5.3'),
      intelligence: 'high',
      capabilities: ['text'],
      pricing: {
        inputUsdPerMillion: 1.4,
        cachedInputUsdPerMillion: 0.26,
        outputUsdPerMillion: 4.4,
        source: SRC_ZAI,
        checkedAt: DEFAULT_CHECKED_AT,
      },
      speed: 63.7,
    }),
    model('glm-5.3-flash', {
      canonicalModel: canonical('glm-5.3-flash'),
      intelligence: 'mid',
      capabilities: ['text'],
      pricing: {
        inputUsdPerMillion: 0.15,
        cachedInputUsdPerMillion: 0.03,
        outputUsdPerMillion: 0.50,
        source: SRC_ZAI,
        checkedAt: DEFAULT_CHECKED_AT,
      },
      speed: 73.1,
    }),
  ],
  modelAliases: { 'hy4-preview-ioa': 'hy4-preview' },
  // Native CodeBuddy CLI `--effort` accepts low/medium/high/xhigh/max, so the
  // confirmed Flash + K3 families map each declared level to its exact wire alias.
  thinkingMappings: {
    'deepseek-v4.1-flash': { codebuddy: effortLadder(THINKING_LOW_HIGH_MAX) },
    'kimi-k3': { codebuddy: effortLadder(THINKING_LOW_HIGH_MAX) },
  },
  protocols: [{ protocol: 'openai_chat', endpoint: 'https://copilot.tencent.com/v2/chat/completions', authScheme: 'bearer' }],
};

export const CODEBUDDY_FREE_MODEL_IDS: ReadonlySet<string> = new Set(
  codeBuddyProvider.models.filter((entry) => entry.free === true).map((entry) => entry.id),
);
