import { builtinModelDisplayName } from '@wrenyard/models';
import type { ProviderDefinition, IntelligenceTier, ModelCapability, ModelDefinition, ModelPricing, ThinkingLevel } from './catalog.ts';

type RawModelDefinition = Omit<ModelDefinition, 'speed' | 'intelligence' | 'pricing'> & {
  speed?: number;
  intelligence?: IntelligenceTier;
  pricing?: ModelPricing;
};

type RawProviderDefinition = Omit<ProviderDefinition, 'models'> & { models: readonly RawModelDefinition[] };

export const model = (
  id: string,
  contextWindow?: number,
  maxTokens?: number,
  canonicalId?: string,
  thinkingLevels?: readonly ThinkingLevel[],
): RawModelDefinition => {
  const canonical = canonicalId === undefined
    ? undefined
    : { id: canonicalId, displayName: builtinModelDisplayName(canonicalId) };
  return {
    id,
    displayName: canonical?.displayName ?? builtinModelDisplayName(id),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(canonical ? { canonicalModel: canonical } : {}),
    ...(thinkingLevels ? { thinkingLevels } : {}),
  };
};

export const openAI = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'openai_chat' as const, endpoint, authScheme });
export const anthropic = (endpoint: string, authScheme: 'bearer' | 'x-api-key' = 'bearer') =>
  ({ protocol: 'anthropic_messages' as const, endpoint, authScheme });

// Public thinking levels declared by confirmed model families. GPT-5.6/6
// use the full five-level ladder; older GPT-5.5/5.4
// cap at xhigh; DeepSeek Flash and Kimi K3 support low/high/max.
export const THINKING_FULL: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const THINKING_UP_TO_XHIGH: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh'];
export const THINKING_LOW_HIGH_MAX: readonly ThinkingLevel[] = ['low', 'high', 'max'];

// A level ladder expressed as a runtime effort alias (identity alias). Used for
// native Codex/CodeBuddy effort flags and gateway effort flags.
export const effortLadder = (levels: readonly ThinkingLevel[]): Readonly<Record<string, { effort: string }>> =>
  Object.fromEntries(levels.map((level) => [level, { effort: level }]));



// Catalog TPS baselines. A valid exact-profile local agent_turn_v1 sample
// supersedes these, as does an exact provider override.
// Keys are exact registered model ids; aliases are never used for lookup.
const MODEL_SPEED_DEFAULTS: Readonly<Record<string, number>> = {
  'deepseek/deepseek-flash': 207,
  'deepseek-v4.1-flash': 201,
  'MiniMax-M2.7': 60,
  'MiniMax-M2.7-highspeed': 100,
  'MiniMax-M3': 156,
  'claude-haiku-4-5-20251001': 81,
  'claude-opus-5': 50,
  'claude-sonnet-5': 60,
  'composer-2.5': 40,
  'grok-4.6': 59,
  'grok-4.7': 59,
  'muse-spark-1.3': 40,
  'gemini-3.8-flash': 40,
  'claude-fable-5-1': 40,
  'doubao-seed-2-0-lite-260215': 35,
  'glm-5.2': 63,
  'glm-5.3': 64,
  'glm-5.3-flash': 73,
  'gpt-5.6-luna': 107,
  'gpt-5.6-sol': 63,
  'gpt-5.6-terra': 98,
  'gpt-6-astra': 51,
  hy3: 94,
  'hy4-preview': 38,
  k3: 40,
  'kimi-k2.5': 40,
  'kimi-k2.6': 56,
  'kimi-k2.8': 40,
  'kimi-k3': 40,
  'minimax-m2.7': 71,
  'minimax-m3': 156,
  'qwen3-coder-next': 128,
  'qwen3-coder-plus': 29,
  'qwen3.5-plus': 54,
  'qwen3.6-plus': 56,
  'qwen3.7-flash': 111,
  'qwen3.7-plus': 56,
  'qwen3.8-max': 39,
  'mimo-v2.5-free': 29,
  'ling-3.0-flash-fin-free': 119,
  'nex-agi/nex-n2.5-mini:free': 119,
  'nex-agi/nex-n2.5-pro:free': 20,
  'cohere/north-mini-code:free': 78,
  'inclusionai/ling-3.0-flash-vl:free': 20,
  'inclusionai/ling-3.0-flash-sante:free': 20,
  'inclusionai/ling-3.0-flash-fin:free': 119,
  'qwen/qwen3.8-27b:free': 20,
  'dots-studio/dots-3-note-preview:free': 20,
  'liquid/lfm-2.5-2.6b:free': 20,
  'nvidia/nemotron-3.5-lightning:free': 20,
  'thinkingmachines/inkling-small:free': 20,
  'thinkingmachines/inkling:free': 20,
  'poolside/laguna-s-2.1:free': 20,
  'poolside/laguna-xs-2.1:free': 20,
  'nvidia/nemotron-3-ultra-550b-a55b:free': 20,
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 20,
  'google/gemma-4-26b-a4b-it:free': 20,
  'google/gemma-4-31b-it:free': 20,
  'nvidia/nemotron-3-super-120b-a12b:free': 20,
  'big-pickle': 20,
  'union-alpha': 20,
  'nemotron-3-ultra-free': 20,
  'nemotron-3.5-lightning-free': 20,
  'deepseek-flash': 207,
  'deepseek-pro': 20,
};

type ModelMeta = {
  thinkingLevels?: readonly ThinkingLevel[];
  intelligence: IntelligenceTier;
  capabilities: readonly ModelCapability[];
  maxOutputTokens?: number;
  pricing: ModelPricing;
};

const MODEL_METADATA: Readonly<Record<string, ModelMeta>> = {
  'deepseek-v4.1-flash': {
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.006, 0.3, 1.2],
  },
  'deepseek/deepseek-flash': {
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.006, 0.3, 1.2],
  },
  'deepseek-flash': {
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.006, 0.3, 1.2],
  },
  // Previous-generation flagship, still billed at its own tariff. No vision,
  // and DeepSeek's own V4.1 Flash announcement puts Flash ahead of it on
  // benchmarks, so it does not claim a higher intelligence tier than Flash.
  // Peak rates, matching the peak convention used for every DeepSeek row here.
  'deepseek-pro': {
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.044, 1.32, 3.96],
  },
  'hy4-preview': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.042, 0.834, 2.501],
  },
  'hy3': {
    intelligence: 'low',
    capabilities: ['text'],
    // Canonical CodeBuddy hunyuan model. Reference price derived from the
    // official Tencent TokenHub CNY list 1/0.25/4 (input/cached/output) using
    // the repository's fixed 7.2 CNY/USD with three-decimal convention.
    pricing: [0.035, 0.139, 0.556],
  },
  'gpt-6-astra': {
    intelligence: 'premium',
    capabilities: ['text', 'image'],
    maxOutputTokens: 128_000,
    pricing: [1, 10, 50],
  },
  'gpt-5.6-sol': {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.4, 4, 20],
  },
  'gpt-5.6-terra': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.2, 2, 12],
  },
  'gpt-5.6-luna': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.02, 0.2, 1.2],
  },
  'kimi-k2.8': {
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'kimi-k3': {
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.30, 3, 15],
  },
  'k3': {
    thinkingLevels: THINKING_LOW_HIGH_MAX,
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.30, 3, 15],
  },
  'glm-5.3': {
    intelligence: 'high',
    capabilities: ['text'],
    pricing: [0.26, 1.4, 4.4],
  },
  'glm-5.3-flash': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.03, 0.15, 0.50],
  },
  'minimax-m2.7': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'MiniMax-M2.7': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'MiniMax-M2.7-highspeed': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'minimax-m3': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'MiniMax-M3': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'composer-2.5': {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    pricing: [0.2, 0.5, 2.5],
  },
  'grok-4.6': {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.5, 2, 6],
  },
  'grok-4.7': {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.5, 2, 6],
  },
  'muse-spark-1.3': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.15, 1.25, 4.25],
  },
  'gemini-3.8-flash': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.075, 0.75, 3.5],
  },
  'claude-fable-5-1': {
    intelligence: 'premium',
    capabilities: ['text', 'image'],
    pricing: [0.25, 10, 50],
  },
  'qwen3-coder-next': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'qwen3-coder-plus': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'qwen3.7-plus': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'qwen3.7-flash': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'qwen3.8-max': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'claude-haiku-4-5-20251001': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.1, 1, 5],
  },
  'glm-5.2': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.26, 1.4, 4.4],
  },
  'kimi-k2.5': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'kimi-k2.6': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'qwen3.6-plus': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'qwen3.5-plus': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'claude-opus-5': {
    intelligence: 'premium',
    capabilities: ['text'],
    pricing: [0.5, 5, 25],
  },
  'claude-sonnet-5': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.2, 2, 10],
  },
  'doubao-seed-2-0-lite-260215': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'mimo-v2.5-free': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'ling-3.0-flash-fin-free': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'nex-agi/nex-n2.5-mini:free': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'nex-agi/nex-n2.5-pro:free': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'cohere/north-mini-code:free': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'inclusionai/ling-3.0-flash-vl:free': {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'inclusionai/ling-3.0-flash-sante:free': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'inclusionai/ling-3.0-flash-fin:free': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'qwen/qwen3.8-27b:free': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'dots-studio/dots-3-note-preview:free': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'liquid/lfm-2.5-2.6b:free': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'nvidia/nemotron-3.5-lightning:free': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'thinkingmachines/inkling-small:free': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'thinkingmachines/inkling:free': {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'poolside/laguna-s-2.1:free': {
    intelligence: 'high',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'poolside/laguna-xs-2.1:free': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'nvidia/nemotron-3-ultra-550b-a55b:free': {
    intelligence: 'high',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'google/gemma-4-26b-a4b-it:free': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'google/gemma-4-31b-it:free': {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    pricing: [0.003, 0.15, 0.6],
  },
  'nvidia/nemotron-3-super-120b-a12b:free': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'big-pickle': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'union-alpha': {
    intelligence: 'mid',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'nemotron-3-ultra-free': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
  'nemotron-3.5-lightning-free': {
    intelligence: 'low',
    capabilities: ['text'],
    pricing: [0.003, 0.15, 0.6],
  },
};

function withMeta(def: RawModelDefinition): ModelDefinition {
  const speed = def.speed ?? MODEL_SPEED_DEFAULTS[def.id];
  if (speed === undefined) {
    throw new Error(`built-in model ${def.id} is missing required default speed`);
  }
  const meta = MODEL_METADATA[def.id];
  const pricing = def.pricing ?? meta?.pricing;
  if (!pricing) {
    throw new Error(`built-in model ${def.id} is missing required pricing metadata`);
  }
  const intelligence = def.intelligence ?? meta?.intelligence;
  if (intelligence !== 'low' && intelligence !== 'mid' && intelligence !== 'high' && intelligence !== 'premium') {
    throw new Error(`built-in model ${def.id} is missing required intelligence tier`);
  }
  if (!meta) {
    return {
      ...def,
      intelligence,
      capabilities: def.capabilities ?? ['text'],
      speed,
      pricing,
    };
  }
  return {
    ...def,
    intelligence,
    ...(def.thinkingLevels ?? meta.thinkingLevels ? { thinkingLevels: def.thinkingLevels ?? meta.thinkingLevels } : {}),
    capabilities: def.capabilities ?? meta.capabilities,
    speed,
    maxOutputTokens: def.maxOutputTokens ?? meta.maxOutputTokens,
    pricing,
  };
}


export function defineProvider(provider: RawProviderDefinition): ProviderDefinition {
  return { ...provider, models: provider.models.map(withMeta) };
}
