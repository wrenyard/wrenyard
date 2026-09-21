import { INTELLIGENCE_TIERS, THINKING_LEVELS, type RegisteredModel } from './types.ts';
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
const THINKING_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

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
  if (!INTELLIGENCE_SET.has(model.defaults.intelligence)) {
    throw new Error(`registered model ${model.id} has invalid intelligence tier`);
  }
  if (!Number.isInteger(model.defaults.speed) || model.defaults.speed <= 0) {
    throw new Error(`registered model ${model.id} speed must be a positive integer`);
  }
  const pricing = model.defaults.pricing;
  if (pricing.length !== 3) {
    throw new Error(`registered model ${model.id} pricing must be [cached, input, output]`);
  }
  for (const [index, value] of pricing.entries()) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`registered model ${model.id} pricing[${index}] must be finite and non-negative`);
    }
  }
  if (model.defaults.capabilities.length === 0) {
    throw new Error(`registered model ${model.id} capabilities must not be empty`);
  }
  const levels = model.defaults.thinkingLevels;
  if (levels !== undefined) {
    if (levels.length === 0) throw new Error(`registered model ${model.id} thinkingLevels must not be empty`);
    const seenLevels = new Set<string>();
    for (const level of levels) {
      if (!THINKING_SET.has(level)) {
        throw new Error(`registered model ${model.id} has invalid thinking level: ${JSON.stringify(level)}`);
      }
      if (seenLevels.has(level)) throw new Error(`registered model ${model.id} has duplicate thinking level ${level}`);
      seenLevels.add(level);
    }
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
}

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
];

/**
 * Default product-enabled model ids for Desktop chat and task dispatch.
 * Older and niche registered identities stay in the registry; providers may
 * adopt this list, then overlay channel CUSTOM offerings.
 */
export const MAINSTREAM_MODEL_IDS = [
  'deepseek-v4.1-flash',
  'deepseek-pro',
  'hunyuan-hy4-preview',
  'hunyuan-hy3',
  'kimi-k3',
  'kimi-k2.8',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'glm-5.3',
  'glm-5.3-flash',
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.7-highspeed',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'grok-4.6',
  'grok-4.5',
  'composer-2.5',
  'muse-spark-1.3',
  'gemini-3.8-flash',
  'doubao-seed-2-0-lite',
  'qwen3.8-max',
  'qwen3.7-plus',
  'qwen3.7-flash',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'qwen3-coder-next',
  'qwen3-coder-plus',
] as const;

export type MainstreamModelId = (typeof MAINSTREAM_MODEL_IDS)[number];

const MAINSTREAM_MODEL_ID_SET: ReadonlySet<string> = new Set(MAINSTREAM_MODEL_IDS);

export function isMainstreamModelId(id: string): boolean {
  return MAINSTREAM_MODEL_ID_SET.has(id);
}

function assertMainstreamModelIds(registry: ModelRegistry): void {
  if (MAINSTREAM_MODEL_ID_SET.size !== MAINSTREAM_MODEL_IDS.length) {
    throw new Error('MAINSTREAM_MODEL_IDS must not contain duplicates');
  }
  for (const id of MAINSTREAM_MODEL_IDS) registry.require(id);
}

export const models = new ModelRegistry(BUILTIN_MODELS);
assertMainstreamModelIds(models);
