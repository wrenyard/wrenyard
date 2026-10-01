/**
 * Pure model-brand logic: family classification, provider→brand mapping and
 * family→brand mapping. No DOM, bridge or window access lives here so the
 * shell, pages and tests can share one canonical mapping.
 */

/**
 * Frontier family order the user confirmed: GPT, Claude, Gemini, Grok. The
 * remaining families follow in this table's order, then the stable fallback.
 */
export const FAMILY_ORDER = [
  'GPT',
  'Claude',
  'Gemini',
  'Grok',
  'DeepSeek',
  'Kimi',
  'GLM',
  'Qwen',
  'MiniMax',
  'Hunyuan',
  'Doubao',
  'Composer',
] as const;

export type ModelFamily = (typeof FAMILY_ORDER)[number] | 'Other';

/** Deterministic prefix classification: a family is a leading id token, never a label guess. */
const FAMILY_PREFIXES: ReadonlyArray<[string, ModelFamily]> = [
  ['gpt', 'GPT'],
  ['o1', 'GPT'],
  ['o3', 'GPT'],
  ['o4', 'GPT'],
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
  ['grok', 'Grok'],
  ['deepseek', 'DeepSeek'],
  ['kimi', 'Kimi'],
  ['glm', 'GLM'],
  ['qwen', 'Qwen'],
  ['minimax', 'MiniMax'],
  ['hunyuan', 'Hunyuan'],
  ['doubao', 'Doubao'],
  ['composer', 'Composer'],
];

/** Brand key shown next to a model name, keyed by family. */
const FAMILY_BRAND: Record<ModelFamily, string> = {
  GPT: 'openai',
  Claude: 'claude',
  Gemini: 'gemini',
  Grok: 'grok',
  DeepSeek: 'deepseek',
  Kimi: 'kimi',
  GLM: 'zhipu',
  Qwen: 'qwen',
  MiniMax: 'minimax',
  Hunyuan: 'hunyuan',
  Doubao: 'doubao',
  Composer: 'cursor',
  Other: '',
};

/** Exact catalog provider id (or prefix) to brand key; unknown ids fall back to the provider id. */
const PROVIDER_BRAND: ReadonlyArray<[string, string]> = [
  ['chatgpt', 'openai'],
  ['openai', 'openai'],
  // `anthropic` is the API provider and `claude-coding` the subscription one;
  // both render the Claude brand.
  ['anthropic', 'claude'],
  ['anthropic-api', 'claude'],
  ['claude-coding', 'claude'],
  ['claude', 'claude'],
  ['gemini', 'gemini'],
  ['google', 'gemini'],
  ['spacex-ai', 'grok'],
  ['super-grok', 'grok'],
  ['grok', 'grok'],
  ['deepseek', 'deepseek'],
  ['kimi', 'kimi'],
  ['moonshot', 'kimi'],
  ['zhipu', 'zhipu'],
  ['glm', 'zhipu'],
  ['qwen', 'qwen'],
  ['minimax', 'minimax'],
  ['hunyuan', 'hunyuan'],
  ['doubao', 'doubao'],
  ['volcengine', 'volcengine'],
  ['tokenhub', 'tencentcloud'],
  ['tencent', 'tencentcloud'],
  ['codebuddy', 'codebuddy'],
  ['cursor', 'cursor'],
  ['opencode', 'opencode'],
  ['openrouter', 'openrouter'],
];

/** Deterministic leading-token family classification with a stable `Other` fallback. */
export function classifyFamily(id: string): ModelFamily {
  const normalized = id.trim().toLowerCase();
  if (/^hy[0-9]/.test(normalized)) return 'Hunyuan';
  for (const [prefix, family] of FAMILY_PREFIXES) {
    if (normalized.startsWith(prefix)) return family;
  }
  return 'Other';
}

/** Brand key for a catalog provider id; unknown ids return the id itself so a brand icon may still match. */
export function providerBrand(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  for (const [prefix, brand] of PROVIDER_BRAND) {
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) return brand;
  }
  return normalized;
}

export function familyBrand(family: ModelFamily): string {
  return FAMILY_BRAND[family];
}
