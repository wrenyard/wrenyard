// Single source of truth for built-in model display names.
//
// Display text is intentionally hyphen-free ("GLM 5.3", "GPT 6 Astra"); the
// technical ids below stay exactly as registered. This file performs no id
// normalization, no canonical-identity merging, and applies no heuristics to
// unknown/custom model names — callers decide how to present those.

/** Canonical display-name entries, keyed by a stable internal name. */
const BUILTIN_MODEL_DISPLAY_NAMES = {
  'claude-fable-5': 'Claude Fable 5',
  'claude-fable-5-1': 'Claude Fable 5.1',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'composer-2.5': 'Composer 2.5',
  'deepseek-pro': 'DeepSeek V4 Pro',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'doubao-seed-2-0-lite': 'Doubao Seed 2.0 Lite',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'glm-5.2': 'GLM 5.2',
  'glm-5.3': 'GLM 5.3',
  'glm-5.3-flash': 'GLM 5.3 Flash',
  'gpt-5.4': 'GPT 5.4',
  'gpt-5.5': 'GPT 5.5',
  'gpt-5.6-luna': 'GPT 5.6 Luna',
  'gpt-5.6-sol': 'GPT 5.6 Sol',
  'gpt-5.6-terra': 'GPT 5.6 Terra',
  'gpt-6-astra': 'GPT 6 Astra',
  'grok-4.5': 'Grok 4.5',
  'grok-4.6': 'Grok 4.6',
  'hunyuan-hy3': 'HY3',
  'hunyuan-hy4-preview': 'HY4 Preview',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.8': 'Kimi K2.8 Preview',
  'kimi-k3': 'Kimi K3',
  'ling-3.0-flash-fin': 'Ling 3.0 Flash Fin Free',
  'ling-3.0-flash-vl': 'Ling 3.0 Flash VL Free',
  'minimax-m2.7': 'MiniMax M2.7',
  'minimax-m2.7-highspeed': 'MiniMax M2.7 Highspeed',
  'minimax-m3': 'MiniMax M3',
  'mimo-v2.5': 'OpenCode Zen Mimo v2.5 Free',
  'muse-spark-1.3': 'Muse Spark 1.3',
  'north-mini-code': 'North Mini Code Free',
  'nex-n2.5-mini': 'Nex N2.5 Mini Free',
  'nex-n2.5-pro': 'Nex N2.5 Pro Free',
  'big-pickle': 'Big Pickle Free',
  'union-alpha': 'Union Alpha Free',
  'nemotron-3-ultra': 'Nemotron 3 Ultra Free',
  'nemotron-3.5-lightning': 'Nemotron 3.5 Lightning Free',
  'qwen3.8-27b': 'Qwen3.8 27B Free',
  'ling-3.0-flash-sante': 'Ling 3.0 Flash Sante Free',
  'dots-3-note-preview': 'Dots3 Note Preview Free',
  'lfm-2.5-2.6b': 'LFM2.5 2.6B Free',
  'inkling-small': 'Inkling Small Free',
  'laguna-s-2.1': 'Laguna S 2.1 Free',
  'inkling': 'Inkling Free',
  'laguna-xs-2.1': 'Laguna XS 2.1 Free',
  'nemotron-3-nano-omni-30b-a3b-reasoning': 'Nemotron 3 Nano Omni Free',
  'gemma-4-26b-a4b-it': 'Gemma 4 26B A4B Free',
  'gemma-4-31b-it': 'Gemma 4 31B Free',
  'nemotron-3-super-120b-a12b': 'Nemotron 3 Super Free',
  'qwen3-coder-next': 'Qwen3 Coder Next',
  'qwen3-coder-plus': 'Qwen3 Coder Plus',
  'qwen3.5-plus': 'Qwen3.5 Plus',
  'qwen3.6-plus': 'Qwen3.6 Plus',
  'qwen3.7-flash': 'Qwen3.7 Flash',
  'qwen3.7-plus': 'Qwen3.7 Plus',
  'qwen3.8-max': 'Qwen3.8 Max',
} as const;

/** Built-in display-name entry keys. */
export type BuiltinModelName = keyof typeof BUILTIN_MODEL_DISPLAY_NAMES;

/**
 * Exact registered built-in model ids (and documented aliases) mapped onto a
 * shared display-name entry. Aliases point at the same entry rather than
 * repeating the literal.
 */
const BUILTIN_MODEL_NAME_ALIASES = {
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
  'cursor-grok-4.6-high': 'grok-4.6',
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek/deepseek-flash': 'deepseek-v4.1-flash',
  'doubao-seed-2-0-lite-260215': 'doubao-seed-2-0-lite',
  'hy3': 'hunyuan-hy3',
  'hy4-preview': 'hunyuan-hy4-preview',
  'k3': 'kimi-k3',
  'kimi-for-coding': 'kimi-k2.8',
  'ling-3.0-flash-fin-free': 'ling-3.0-flash-fin',
  'mimo-v2.5-free': 'mimo-v2.5',
  'MiniMax-M2.7': 'minimax-m2.7',
  'MiniMax-M2.7-highspeed': 'minimax-m2.7-highspeed',
  'MiniMax-M3': 'minimax-m3',
  'nex-agi/nex-n2.5-mini:free': 'nex-n2.5-mini',
  'cohere/north-mini-code:free': 'north-mini-code',
  'inclusionai/ling-3.0-flash-vl:free': 'ling-3.0-flash-vl',
  'inclusionai/ling-3.0-flash-sante:free': 'ling-3.0-flash-sante',
  'inclusionai/ling-3.0-flash-fin:free': 'ling-3.0-flash-fin',
  'nex-agi/nex-n2.5-pro:free': 'nex-n2.5-pro',
  'qwen/qwen3.8-27b:free': 'qwen3.8-27b',
  'dots-studio/dots-3-note-preview:free': 'dots-3-note-preview',
  'liquid/lfm-2.5-2.6b:free': 'lfm-2.5-2.6b',
  'nvidia/nemotron-3.5-lightning:free': 'nemotron-3.5-lightning',
  'thinkingmachines/inkling-small:free': 'inkling-small',
  'poolside/laguna-s-2.1:free': 'laguna-s-2.1',
  'thinkingmachines/inkling:free': 'inkling',
  'poolside/laguna-xs-2.1:free': 'laguna-xs-2.1',
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'nemotron-3-ultra',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 'nemotron-3-nano-omni-30b-a3b-reasoning',
  'google/gemma-4-26b-a4b-it:free': 'gemma-4-26b-a4b-it',
  'google/gemma-4-31b-it:free': 'gemma-4-31b-it',
  'nvidia/nemotron-3-super-120b-a12b:free': 'nemotron-3-super-120b-a12b',
  'big-pickle': 'big-pickle',
  'union-alpha': 'union-alpha',
  'nemotron-3-ultra-free': 'nemotron-3-ultra',
  'nemotron-3.5-lightning-free': 'nemotron-3.5-lightning',
} as const satisfies Readonly<Record<string, BuiltinModelName>>;

/**
 * Every id/alias the SSOT knows how to display. Callers can key exact lookups
 * on this union to keep declarations honest.
 */
export type BuiltinModelId = BuiltinModelName | keyof typeof BUILTIN_MODEL_NAME_ALIASES;

const BUILTIN_MODEL_DISPLAY_NAME_BY_ID: Readonly<Record<BuiltinModelId, string>> = (() => {
  const table = { ...BUILTIN_MODEL_DISPLAY_NAMES } as Record<string, string>;
  for (const [id, name] of Object.entries(BUILTIN_MODEL_NAME_ALIASES)) {
    table[id] = BUILTIN_MODEL_DISPLAY_NAMES[name];
  }
  return table as Readonly<Record<BuiltinModelId, string>>;
})();

/**
 * Resolves the built-in display name for an exact registered model id or a
 * display alias. Only explicitly registered names are accepted;
 * unknown/custom model presentation belongs to the caller.
 */
export function builtinModelDisplayName(id: BuiltinModelId): string {
  return BUILTIN_MODEL_DISPLAY_NAME_BY_ID[id];
}

/** Display name only when `id` is a registered built-in model or alias. */
export function builtinModelDisplayNameIfKnown(id: string): string | undefined {
  return BUILTIN_MODEL_DISPLAY_NAME_BY_ID[id as BuiltinModelId];
}

/** Current display identity only; never used to regroup historical usage or dispatch. */
export function builtinModelDisplayId(modelId: string): string {
  return (BUILTIN_MODEL_NAME_ALIASES as Readonly<Record<string, string>>)[modelId] ?? modelId;
}
