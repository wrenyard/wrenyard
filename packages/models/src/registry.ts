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
import { reflectionModels } from './definitions/reflection.ts';
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
  // Intelligence and default speed are mandatory registration facts: a model
  // without a legal tier or a positive integer speed is not a usable offering.
  // There is no unknown tier and no absent-speed placeholder.
  if (!INTELLIGENCE_SET.has(model.defaults.intelligence)) {
    throw new Error(`registered model ${model.id} must declare a valid intelligence tier`);
  }
  if (!Number.isInteger(model.defaults.speed) || model.defaults.speed <= 0) {
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
 * modalities. Every entry also declares a deliberate intelligence tier and a
 * seeded default speed, because a registered identity without both is not a
 * usable offering and registration rejects it.
 *
 * The seeded speeds are catalog defaults, not provider measurements: each is a
 * floored positive integer from a public provider throughput source, and a
 * provider-pair measurement or override still takes precedence for that exact
 * pair. `pricing` stays absent here because models.dev supplies none for these
 * rows (and its pricing is tiered for some), so no placeholder price is
 * invented. Consumers read speed and intelligence from the registered identity;
 * provider snapshots own their own pricing, limits and capabilities.
 */
const modelsDevCanonicalModels: readonly RegisteredModel[] = [
  // Seed speed 139: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    speed: 139,
  }, { lab: 'google', family: 'gemini' }),
  // Seed speed 213: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('gemini-3.5-flash', 'Gemini 3.5 Flash', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    speed: 213,
  }, { lab: 'google', family: 'gemini' }),
  // Seed speed 363: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    speed: 363,
  }, { lab: 'google', family: 'gemini' }),
  // Seed speed 71: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('mistral-large-4', 'Mistral Large 4', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 1_048_576,
    speed: 71,
  }, { lab: 'mistral' }),
  // Seed speed 160: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('mistral-medium-3.5', 'Mistral Medium 3.5', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 262_144,
    speed: 160,
  }, { lab: 'mistral' }),
  // Seed speed 153: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('mistral-small-latest', 'Mistral Small', {
    intelligence: 'low',
    capabilities: ['text', 'image'],
    contextWindow: 262_144,
    speed: 153,
  }, { lab: 'mistral' }),
  // Seed speed 121: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('devstral-2', 'Devstral 2', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 262_144,
    speed: 121,
  }, { lab: 'mistral' }),
  // Seed speed 141: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('codestral-latest', 'Codestral', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 256_000,
    speed: 141,
  }, { lab: 'mistral' }),
  // Seed speed 214: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('gpt-oss-120b', 'GPT OSS 120B', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 131_072,
    speed: 214,
  }, { lab: 'openai' }),
  // Seed speed 228: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('gpt-oss-20b', 'GPT OSS 20B', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 131_072,
    speed: 228,
  }, { lab: 'openai' }),
  // Seed speed 92: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('llama-3.3-70b', 'Llama 3.3 70B', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 131_072,
    speed: 92,
  }, { lab: 'meta' }),
  // Speed 450 is the historical advertised TPS from the archived Groq table for
  // the now-decommissioned (2026-09-21) Groq Compound endpoint: a vendor claim,
  // not a controlled measurement, retained as the identity default only.
  defineModel('groq-compound', 'Groq Compound', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 131_072,
    speed: 450,
  }, { lab: 'groq' }),
  // Seed speed 78: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 1_048_576,
    speed: 78,
  }, { lab: 'deepseek', family: 'deepseek-v4' }),
  // Speed 93 is the DigitalOcean provider's non-reasoning after-first-chunk
  // output rate: a provider-specific seed, not an identity-wide benchmark.
  defineModel('deepseek-v3.2', 'DeepSeek V3.2', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 32_768,
    speed: 93,
  }, { lab: 'deepseek', family: 'deepseek-v3' }),
  // Seed speed 206: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('qwen3.7-max', 'Qwen3.7 Max', {
    intelligence: 'high',
    capabilities: ['text'],
    contextWindow: 1_000_000,
    speed: 206,
  }, { lab: 'alibaba', family: 'qwen' }),
  // Seed speed 38: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('qwen3.8-2.4t-a95b', 'Qwen3.8 2.4T A95B', {
    intelligence: 'high',
    capabilities: ['text'],
    contextWindow: 262_144,
    speed: 38,
  }, { lab: 'alibaba', family: 'qwen' }),
  // Seed speed 174: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('command-a-plus', 'Command A Plus', {
    intelligence: 'high',
    capabilities: ['text', 'image'],
    contextWindow: 128_000,
    speed: 174,
  }, { lab: 'cohere', family: 'command' }),
  // Speed 60 comes from a STATIC reference listing, not a measured TPS sample.
  defineModel('command-a-reasoning', 'Command A Reasoning', {
    intelligence: 'high',
    capabilities: ['text'],
    contextWindow: 256_000,
    speed: 60,
  }, { lab: 'cohere', family: 'command' }),
  // Seed speed 63: public provider throughput catalog, floored; not an identity-wide benchmark.
  defineModel('command-a', 'Command A', {
    intelligence: 'mid',
    capabilities: ['text'],
    contextWindow: 256_000,
    speed: 63,
  }, { lab: 'cohere', family: 'command' }),
  // Speed 46 is ModelCap Hugging Face Router telemetry observed 2026-10-17: a
  // router-side observation, not a controlled benchmark.
  defineModel('command-a-vision', 'Command A Vision', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 128_000,
    speed: 46,
  }, { lab: 'cohere', family: 'command' }),
  // Speed 87: one-week P50 from the OpenRouter provider page, not a controlled benchmark.
  defineModel('sonar', 'Sonar', {
    intelligence: 'low',
    capabilities: ['text'],
    contextWindow: 128_000,
    speed: 87,
  }, { lab: 'perplexity', family: 'sonar' }),
  // Speed 84: one-week P50 from the OpenRouter provider page, not a controlled benchmark.
  defineModel('sonar-pro', 'Sonar Pro', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 200_000,
    speed: 84,
  }, { lab: 'perplexity', family: 'sonar' }),
  // Speed 25: one-week P50 from the OpenRouter provider page, not a controlled benchmark.
  defineModel('sonar-reasoning-pro', 'Sonar Reasoning Pro', {
    intelligence: 'mid',
    capabilities: ['text', 'image'],
    contextWindow: 128_000,
    speed: 25,
  }, { lab: 'perplexity', family: 'sonar' }),
  // Speed 49: one-week P50 from the OpenRouter provider page, not a controlled benchmark.
  defineModel('sonar-deep-research', 'Sonar Deep Research', {
    intelligence: 'high',
    capabilities: ['text'],
    contextWindow: 128_000,
    speed: 49,
  }, { lab: 'perplexity', family: 'sonar' }),
];

/**
 * Registered identities whose metadata comes from first-party measurement
 * rather than a public provider catalog.
 *
 * `speed` is generation throughput after the first token, the convention every
 * other registry default follows; whole-turn wall-clock throughput is never
 * used as a registry default.
 */
const devinModels: readonly RegisteredModel[] = [
  // Speed 185 is the median generation throughput after the first token of
  // three streaming runs (239.1, 185.0 and 166.7 TPS). Provenance: coordinator
  // measurement 2026-10-17, Devin, 3 streaming runs, median. Pricing and
  // maxOutputTokens stay absent because they were not established.
  defineModel('swe-2', 'SWE-2', {
    intelligence: 'high',
    capabilities: ['text'],
    contextWindow: 262_144,
    speed: 185,
  }, { lab: 'cognition', family: 'swe' }),
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
  ...reflectionModels,
  ...devinModels,
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
