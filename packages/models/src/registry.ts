import { MAINSTREAM_MODEL_IDS } from './mainstream.ts';
import { INTELLIGENCE_TIERS, type RegisteredModel } from './types.ts';
import { defineModel } from './definitions/define.ts';
import { alibabaModels } from './definitions/alibaba.ts';
import { anthropicModels } from './definitions/anthropic.ts';
import { bytedanceModels } from './definitions/bytedance.ts';
import { cohereModels } from './definitions/cohere.ts';
import { cursorModels } from './definitions/cursor.ts';
import { deepseekModels } from './definitions/deepseek.ts';
import { dotsstudioModels } from './definitions/dotsstudio.ts';
import { googleModels } from './definitions/google.ts';
import { inclusionaiModels } from './definitions/inclusionai.ts';
import { liquidModels } from './definitions/liquid.ts';
import { minimaxModels } from './definitions/minimax.ts';
import { moonshotModels } from './definitions/moonshot.ts';
import { nexagiModels } from './definitions/nexagi.ts';
import { nvidiaModels } from './definitions/nvidia.ts';
import { openaiModels } from './definitions/openai.ts';
import { opencodeModels } from './definitions/opencode.ts';
import { poolsideModels } from './definitions/poolside.ts';
import { spacexaiModels } from './definitions/spacexai.ts';
import { tencentModels } from './definitions/tencent.ts';
import { thinkingmachinesModels } from './definitions/thinkingmachines.ts';
import { xiaomiModels } from './definitions/xiaomi.ts';
import { zhipuModels } from './definitions/zhipu.ts';

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const INTELLIGENCE_SET: ReadonlySet<string> = new Set(INTELLIGENCE_TIERS);

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freezeDeep(nested);
  }
  return value;
}

function validateModel(model: RegisteredModel, seen: Set<string>): void {
  if (!model.id.trim() || !MODEL_ID_PATTERN.test(model.id)) {
    throw new Error(`registered model id is invalid: ${JSON.stringify(model.id)}`);
  }
  if (seen.has(model.id)) throw new Error(`duplicate registered model: ${model.id}`);
  seen.add(model.id);
  if (!model.displayName.trim()) {
    throw new Error(`registered model ${model.id} has an empty display name`);
  }
  if (!model.lab.trim()) {
    throw new Error(`registered model ${model.id} lab must be a non-empty string`);
  }
  if (model.defaults.intelligence !== undefined && !INTELLIGENCE_SET.has(model.defaults.intelligence)) {
    throw new Error(`registered model ${model.id} has invalid intelligence tier`);
  }
  if (model.defaults.speed !== undefined
    && (!Number.isInteger(model.defaults.speed) || model.defaults.speed <= 0)) {
    throw new Error(`registered model ${model.id} speed must be a positive integer`);
  }
  // Free status is an explicit classification, never derived from pricing: it
  // is validated as a plain boolean and nothing about `pricing` is consulted.
  if (model.defaults.free !== undefined && typeof model.defaults.free !== 'boolean') {
    throw new Error(`registered model ${model.id} free must be a boolean`);
  }
  if (!Number.isSafeInteger(model.defaults.contextWindow) || model.defaults.contextWindow <= 0) {
    throw new Error(`registered model ${model.id} context window must be a positive integer`);
  }
  const pricing = model.defaults.pricing;
  if (pricing !== undefined) {
    if (pricing.length !== 3) {
      throw new Error(`registered model ${model.id} pricing must be [cached, input, output]`);
    }
    for (const [index, value] of pricing.entries()) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`registered model ${model.id} pricing[${index}] must be finite and non-negative`);
      }
    }
  }
  if (model.defaults.capabilities.length === 0) {
    throw new Error(`registered model ${model.id} capabilities must not be empty`);
  }
}

export class ModelRegistry {
  private readonly modelsById = new Map<string, RegisteredModel>();

  constructor(models: readonly RegisteredModel[]) {
    const seen = new Set<string>();
    for (const model of models) {
      validateModel(model, seen);
      this.modelsById.set(model.id, freezeDeep(structuredClone(model)));
    }
  }

  get(id: string): RegisteredModel | undefined {
    return this.modelsById.get(id);
  }

  require(id: string): RegisteredModel {
    const model = this.modelsById.get(id);
    if (!model) throw new Error(`unknown registered model: ${id}`);
    return model;
  }

  list(): readonly RegisteredModel[] {
    return [...this.modelsById.values()];
  }

  /** Display name of an exact registered model id. */
  displayName(id: string): string | undefined {
    return this.modelsById.get(id)?.displayName;
  }
}

/** Display name of an exact WY model id. Provider spellings resolve through that provider's canonical model first. */
export function builtinModelDisplayName(id: string): string {
  const name = models.displayName(id);
  if (name === undefined) throw new Error(`unknown registered model: ${id}`);
  return name;
}

/**
 * Canonical identities for the models.dev-derived mainstream providers.
 *
 * Each entry is an identity: the exact canonical id, its hyphen-free SSOT
 * display name, the origin lab, the source context window and the source input
 * modalities. `intelligence`, `speed` and `pricing` are deliberately absent —
 * models.dev supplies none of them for these rows (and its pricing is tiered
 * for some), so no placeholder value is invented here. Providers that publish
 * these identities opt out of the canonical metadata fallback and carry exactly
 * the metadata their own snapshot supplies.
 */
const modelsDevCanonicalModels: readonly RegisteredModel[] = [
  defineModel('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', { capabilities: ['text', 'image'], contextWindow: 1_048_576 }, { lab: 'google', family: 'gemini' }),
  defineModel('gemini-3.5-flash', 'Gemini 3.5 Flash', { capabilities: ['text', 'image'], contextWindow: 1_048_576 }, { lab: 'google', family: 'gemini' }),
  defineModel('gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', { capabilities: ['text', 'image'], contextWindow: 1_048_576 }, { lab: 'google', family: 'gemini' }),
  defineModel('mistral-large-4', 'Mistral Large 4', { capabilities: ['text', 'image'], contextWindow: 1_048_576 }, { lab: 'mistral' }),
  defineModel('mistral-medium-3.5', 'Mistral Medium 3.5', { capabilities: ['text', 'image'], contextWindow: 262_144 }, { lab: 'mistral' }),
  defineModel('mistral-small-latest', 'Mistral Small', { capabilities: ['text', 'image'], contextWindow: 262_144 }, { lab: 'mistral' }),
  defineModel('devstral-2', 'Devstral 2', { capabilities: ['text'], contextWindow: 262_144 }, { lab: 'mistral' }),
  defineModel('codestral-latest', 'Codestral', { capabilities: ['text'], contextWindow: 256_000 }, { lab: 'mistral' }),
  defineModel('gpt-oss-120b', 'GPT OSS 120B', { capabilities: ['text'], contextWindow: 131_072 }, { lab: 'openai' }),
  defineModel('gpt-oss-20b', 'GPT OSS 20B', { capabilities: ['text'], contextWindow: 131_072 }, { lab: 'openai' }),
  defineModel('llama-3.3-70b', 'Llama 3.3 70B', { capabilities: ['text'], contextWindow: 131_072 }, { lab: 'meta' }),
  defineModel('groq-compound', 'Groq Compound', { capabilities: ['text'], contextWindow: 131_072 }, { lab: 'groq' }),
  defineModel('deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', { capabilities: ['text'], contextWindow: 1_048_576 }, { lab: 'deepseek', family: 'deepseek-v4' }),
  defineModel('deepseek-v3.2', 'DeepSeek V3.2', { capabilities: ['text'], contextWindow: 32_768 }, { lab: 'deepseek', family: 'deepseek-v3' }),
  defineModel('qwen3.7-max', 'Qwen3.7 Max', { capabilities: ['text'], contextWindow: 1_000_000 }, { lab: 'alibaba', family: 'qwen' }),
  defineModel('qwen3.8-2.4t-a95b', 'Qwen3.8 2.4T A95B', { capabilities: ['text'], contextWindow: 262_144 }, { lab: 'alibaba', family: 'qwen' }),
  defineModel('command-a-plus', 'Command A Plus', { capabilities: ['text', 'image'], contextWindow: 128_000 }, { lab: 'cohere', family: 'command' }),
  defineModel('command-a-reasoning', 'Command A Reasoning', { capabilities: ['text'], contextWindow: 256_000 }, { lab: 'cohere', family: 'command' }),
  defineModel('command-a', 'Command A', { capabilities: ['text'], contextWindow: 256_000 }, { lab: 'cohere', family: 'command' }),
  defineModel('command-a-vision', 'Command A Vision', { capabilities: ['text', 'image'], contextWindow: 128_000 }, { lab: 'cohere', family: 'command' }),
  defineModel('sonar', 'Sonar', { capabilities: ['text'], contextWindow: 128_000 }, { lab: 'perplexity', family: 'sonar' }),
  defineModel('sonar-pro', 'Sonar Pro', { capabilities: ['text', 'image'], contextWindow: 200_000 }, { lab: 'perplexity', family: 'sonar' }),
  defineModel('sonar-reasoning-pro', 'Sonar Reasoning Pro', { capabilities: ['text', 'image'], contextWindow: 128_000 }, { lab: 'perplexity', family: 'sonar' }),
  defineModel('sonar-deep-research', 'Sonar Deep Research', { capabilities: ['text'], contextWindow: 128_000 }, { lab: 'perplexity', family: 'sonar' }),
];

const BUILTIN_MODELS: readonly RegisteredModel[] = [
  ...deepseekModels,
  ...tencentModels,
  ...moonshotModels,
  ...openaiModels,
  ...zhipuModels,
  ...minimaxModels,
  ...anthropicModels,
  ...spacexaiModels,
  ...cursorModels,
  ...googleModels,
  ...bytedanceModels,
  ...alibabaModels,
  ...xiaomiModels,
  ...inclusionaiModels,
  ...cohereModels,
  ...nexagiModels,
  ...opencodeModels,
  ...nvidiaModels,
  ...dotsstudioModels,
  ...liquidModels,
  ...thinkingmachinesModels,
  ...poolsideModels,
  ...modelsDevCanonicalModels,
];

function assertMainstreamModelIds(registry: ModelRegistry): void {
  if (new Set(MAINSTREAM_MODEL_IDS).size !== MAINSTREAM_MODEL_IDS.length) {
    throw new Error('MAINSTREAM_MODEL_IDS must not contain duplicates');
  }
  for (const id of MAINSTREAM_MODEL_IDS) registry.require(id);
}

export const models = new ModelRegistry(BUILTIN_MODELS);
assertMainstreamModelIds(models);
