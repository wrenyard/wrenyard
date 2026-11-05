/**
 * Static catalog metadata verified against models.dev on 2026-11-05.
 *
 * Each entry names the source row in its comment. `maxInputTokens` keeps an
 * explicit input limit separate from the total `contextWindow`;
 * `maxOutputTokens` is never derived from the context window. Reasoning
 * efforts keep only levels in the public vocabulary, and input modalities
 * keep every modality the source lists. A field a source does not establish
 * is omitted instead of guessed; the registry rejects an entry without an
 * input limit or input modalities.
 */
import type { ModelDefaults } from '../types.ts';

type CatalogMetadata = Partial<Pick<ModelDefaults, 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens' | 'reasoningEfforts' | 'inputModalities'>>;

export const CATALOG_METADATA: Readonly<Record<string, CatalogMetadata>> = {
  // models.dev: cortecs/deepseek-v4.1-flash
  'deepseek-v4.1-flash': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 393_216,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text', 'image'],
  },
  // models.dev: opencode/deepseek-v4.1-flash-free
  'deepseek-v4.1-flash-free': {
    contextWindow: 200_000,
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text', 'image'],
  },
  // models.dev: deepseek/deepseek-v4-pro
  'deepseek-v4-pro': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 393_216,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text'],
  },
  // models.dev: tencent-tokenhub/hy3
  'hunyuan-hy3': {
    contextWindow: 256_000,
    maxInputTokens: 192_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['none', 'high'],
    inputModalities: ['text'],
  },
  // models.dev: tencent-tokenhub/hy4-preview
  'hunyuan-hy4-preview': {
    contextWindow: 1_024_000,
    maxInputTokens: 1_024_000,
    maxOutputTokens: 64_000,
    reasoningEfforts: ['none', 'high'],
    inputModalities: ['text'],
  },
  // models.dev: 302ai/kimi-k2.5
  'kimi-k2.5': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 262_144,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: moonshotai/kimi-k2.6
  'kimi-k2.6': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 262_144,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: kimi-code-plan-global/kimi-for-coding
  'kimi-k2.8': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 32_768,
    reasoningEfforts: ['none', 'low', 'high', 'max'],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: moonshotai/kimi-k3.1-pro
  'kimi-k3.1-pro': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 1_048_576,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: moonshotai/kimi-k3
  'kimi-k3': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 1_048_576,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: openai/gpt-6-astra
  'gpt-6-astra': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: openai/gpt-6-sol
  'gpt-6-sol': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: openai/gpt-6-luna
  'gpt-6-luna': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: openai/gpt-6.1-sol
  'gpt-6.1-sol': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: openai/gpt-6.1-terra
  'gpt-6.1-terra': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: openai/gpt-5.6-sol
  'gpt-5.6-sol': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: openai/gpt-5.6-terra
  'gpt-5.6-terra': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: openai/gpt-5.6-luna
  'gpt-5.6-luna': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: azure/gpt-5.5
  'gpt-5.5': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: azure/gpt-5.4
  'gpt-5.4': {
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: zhipuai/glm-5.3
  'glm-5.3': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text'],
  },
  // models.dev: zhipuai/glm-5.3-flash
  'glm-5.3-flash': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text', 'image', 'video', 'pdf'],
  },
  // models.dev: zhipuai/glm-5.2
  'glm-5.2': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['high', 'max'],
    inputModalities: ['text'],
  },
  // models.dev: minimax/MiniMax-M3.1-Flash
  'minimax-m3.1-flash': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 524_288,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: minimax/MiniMax-M3
  'minimax-m3': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 524_288,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: minimax/MiniMax-M2.7
  'minimax-m2.7': {
    contextWindow: 204_800,
    maxInputTokens: 204_800,
    maxOutputTokens: 131_072,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: minimax/MiniMax-M2.7-highspeed
  'minimax-m2.7-highspeed': {
    contextWindow: 204_800,
    maxInputTokens: 204_800,
    maxOutputTokens: 131_072,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: anthropic/claude-fable-5
  'claude-fable-5': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: anthropic/claude-fable-5-1
  'claude-fable-5-1': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: anthropic/claude-opus-5
  'claude-opus-5': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: anthropic/claude-opus-5-5
  'claude-opus-5-5': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: anthropic/claude-sonnet-5
  'claude-sonnet-5': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: anthropic/claude-sonnet-5-5
  'claude-sonnet-5-5': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: anthropic/claude-haiku-5-5
  'claude-haiku-5-5': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: xai/grok-4.7
  'grok-4.7': {
    contextWindow: 500_000,
    maxInputTokens: 500_000,
    maxOutputTokens: 500_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: meta/muse-spark-1.3
  'muse-spark-1.3': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'video', 'pdf', 'audio'],
  },
  // models.dev: google/gemini-3.8-flash
  'gemini-3.8-flash': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text', 'image', 'video', 'audio', 'pdf'],
  },
  // models.dev: google/gemini-4-argon
  'gemini-4-argon': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 32_768,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text', 'image', 'video', 'audio', 'pdf'],
  },
  // models.dev: google/gemma-4-26b-a4b-it
  'gemma-4-26b-a4b-it': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 32_768,
    reasoningEfforts: [],
    inputModalities: ['text', 'image'],
  },
  // models.dev: google/gemma-4-31b-it
  'gemma-4-31b-it': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 32_768,
    reasoningEfforts: [],
    inputModalities: ['text', 'image'],
  },
  // models.dev: volcengine/doubao-seed-2-0-lite-260428
  'doubao-seed-2-0-lite': {
    contextWindow: 256_000,
    maxInputTokens: 256_000,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: alibaba/qwen3.8-max
  'qwen3.8-max': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['low', 'medium', 'xhigh'],
    inputModalities: ['text', 'image', 'video', 'pdf'],
  },
  // models.dev: alibaba/qwen3.7-plus
  'qwen3.7-plus': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: alibaba/qwen3.7-flash
  'qwen3.7-flash': {
    contextWindow: 1_000_000,
    maxInputTokens: 991_808,
    maxOutputTokens: 131_072,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: alibaba/qwen3.6-plus
  'qwen3.6-plus': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: alibaba/qwen3.5-plus
  'qwen3.5-plus': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: cortecs/qwen3-coder-next
  'qwen3-coder-next': {
    contextWindow: 256_000,
    maxInputTokens: 256_000,
    maxOutputTokens: 256_000,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: alibaba/qwen3-coder-plus
  'qwen3-coder-plus': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: cortecs/qwen3.8-27b
  'qwen3.8-27b': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 500_000,
    reasoningEfforts: ['low', 'medium', 'xhigh'],
    inputModalities: ['text', 'image'],
  },
  // models.dev: xiaomi/mimo-v2.5
  'mimo-v2.5': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 131_072,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'audio', 'video'],
  },
  // models.dev: xiaomi/mimo-v2.6-pro
  'mimo-v2.6-pro': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 131_072,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'audio', 'video'],
  },
  // models.dev: xiaomi/mimo-v2.6-flash
  'mimo-v2.6-flash': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 131_072,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'audio', 'video'],
  },
  // models.dev: xiaomi/mimo-v2.6-pro-ultraspeed
  'mimo-v2.6-pro-ultraspeed': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 131_072,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'audio', 'video'],
  },
  // models.dev: vercel/inclusionai/ling-3.0-flash-fin
  'ling-3.0-flash-fin': {
    contextWindow: 256_000,
    maxInputTokens: 256_000,
    maxOutputTokens: 32_000,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: llmgateway/ling-3.0-flash-vl
  'ling-3.0-flash-vl': {
    contextWindow: 131_072,
    maxInputTokens: 131_072,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    inputModalities: ['text', 'image'],
  },
  // models.dev: vercel/inclusionai/ling-3.0-flash-sante
  'ling-3.0-flash-sante': {
    contextWindow: 256_000,
    maxInputTokens: 256_000,
    maxOutputTokens: 32_000,
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    inputModalities: ['text'],
  },
  // models.dev: cohere/north-mini-code-1-0
  'north-mini-code': {
    contextWindow: 256_000,
    maxInputTokens: 256_000,
    maxOutputTokens: 64_000,
    reasoningEfforts: ['none', 'high'],
    inputModalities: ['text'],
  },
  // models.dev: openrouter/nex-agi/nex-n2.5-mini
  'nex-n2.5-mini': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 235_929,
    reasoningEfforts: ['none', 'medium', 'high'],
    inputModalities: ['text', 'image'],
  },
  // models.dev: openrouter/nex-agi/nex-n2.5-pro
  'nex-n2.5-pro': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 235_929,
    reasoningEfforts: ['none', 'medium', 'high'],
    inputModalities: ['text', 'image'],
  },
  // models.dev: opencode/big-pickle
  'big-pickle': {
    contextWindow: 200_000,
    maxInputTokens: 160_000,
    maxOutputTokens: 32_000,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: no current public row; existing catalog limits retained
  'union-alpha': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    inputModalities: ['text'],
  },
  // models.dev: nvidia/nvidia/nemotron-3-ultra-550b-a55b
  'nemotron-3-ultra': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['none', 'medium', 'high'],
    inputModalities: ['text'],
  },
  // models.dev: nvidia/nvidia/nemotron-3.5-lightning-30b-a3b
  'nemotron-3.5-lightning': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 262_144,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
  'nemotron-3-nano-omni-30b-a3b-reasoning': {
    contextWindow: 256_000,
    maxInputTokens: 256_000,
    maxOutputTokens: 65_536,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'video', 'audio'],
  },
  // models.dev: requesty/nemotron-3-super-120b-a12b
  'nemotron-3-super-120b-a12b': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'max'],
    inputModalities: ['text'],
  },
  // models.dev: nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b
  'nemotron-3.5-super-vl-120b-a12b': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 8_192,
    reasoningEfforts: [],
    inputModalities: ['text', 'image', 'video'],
  },
  // models.dev: openrouter/dots-studio/dots-3-note-preview:free
  'dots-3-note-preview': {
    contextWindow: 512_000,
    maxInputTokens: 512_000,
    maxOutputTokens: 460_800,
    reasoningEfforts: [],
    inputModalities: ['text', 'image'],
  },
  // models.dev: openrouter/liquid/lfm-2.5-2.6b:free
  'lfm-2.5-2.6b': {
    contextWindow: 65_536,
    maxInputTokens: 65_536,
    maxOutputTokens: 8_192,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: thinkingmachines/thinkingmachines/Inkling-Small
  'inkling-small': {
    contextWindow: 65_536,
    maxInputTokens: 65_536,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text', 'image'],
  },
  // models.dev: neon/inkling
  'inkling': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'max'],
    inputModalities: ['text', 'image', 'audio'],
  },
  // models.dev: poolside/poolside/laguna-s-2.1
  'laguna-s-2.1': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 32_768,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: poolside/poolside/laguna-xs-2.1
  'laguna-xs-2.1': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 32_768,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: reflection/Beam-1.0-501B-A23B
  'beam-1.0-501b-a23b': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    inputModalities: ['text'],
  },
  // models.dev: no current public row; existing catalog limits retained
  'swe-2': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    inputModalities: ['text'],
  },
  // models.dev: google-vertex/gemini-3.1-pro-preview
  'gemini-3.1-pro-preview': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text', 'image', 'video', 'audio', 'pdf'],
  },
  // models.dev: google-vertex/gemini-3.5-flash
  'gemini-3.5-flash': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text', 'image', 'video', 'audio', 'pdf'],
  },
  // models.dev: google-vertex/gemini-3.1-flash-lite
  'gemini-3.1-flash-lite': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text', 'image', 'video', 'audio', 'pdf'],
  },
  // models.dev: mistral/mistral-large-4
  'mistral-large-4': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 262_144,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: llmgateway/mistral-medium-3-5
  'mistral-medium-3.5': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 262_144,
    reasoningEfforts: [],
    inputModalities: ['text', 'image'],
  },
  // models.dev: mistral/mistral-small-latest
  'mistral-small-latest': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 256_000,
    reasoningEfforts: ['none', 'high'],
    inputModalities: ['text', 'image', 'pdf'],
  },
  // models.dev: mistral/devstral-2512
  'devstral-2': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 262_144,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: mistral/codestral-latest
  'codestral-latest': {
    contextWindow: 256_000,
    maxInputTokens: 256_000,
    maxOutputTokens: 4_096,
    reasoningEfforts: [],
    inputModalities: ['text', 'pdf'],
  },
  // models.dev: amazon-bedrock/us-gov.openai.gpt-oss-120b-1:0
  'gpt-oss-120b': {
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text'],
  },
  // models.dev: amazon-bedrock/openai.gpt-oss-20b
  'gpt-oss-20b': {
    contextWindow: 131_072,
    maxInputTokens: 131_072,
    maxOutputTokens: 131_072,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text'],
  },
  // models.dev: cortecs/llama-3.3-70b-instruct
  'llama-3.3-70b': {
    contextWindow: 131_000,
    maxInputTokens: 131_000,
    maxOutputTokens: 131_000,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: no current public row; existing catalog limits retained
  'groq-compound': {
    contextWindow: 131_072,
    maxInputTokens: 131_072,
    maxOutputTokens: 8_192,
    inputModalities: ['text'],
  },
  // models.dev: deepseek/deepseek-v4-pro
  'deepseek-v4-pro-0813': {
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 393_216,
    reasoningEfforts: ['low', 'high', 'max'],
    inputModalities: ['text'],
  },
  // models.dev: cortecs/deepseek-v3.2
  'deepseek-v3.2': {
    contextWindow: 163_840,
    maxInputTokens: 163_840,
    maxOutputTokens: 65_536,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text'],
  },
  // models.dev: alibaba/qwen3.7-max
  'qwen3.7-max': {
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 131_072,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: cortecs/qwen3.8-2.4t-a95b
  'qwen3.8-2.4t-a95b': {
    contextWindow: 262_144,
    maxInputTokens: 262_144,
    maxOutputTokens: 262_144,
    reasoningEfforts: ['low', 'medium', 'xhigh'],
    inputModalities: ['text'],
  },
  // models.dev: cohere/command-a-plus-05-2026
  'command-a-plus': {
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 64_000,
    reasoningEfforts: [],
    inputModalities: ['text', 'image'],
  },
  // models.dev: cohere/command-a-reasoning-08-2025
  'command-a-reasoning': {
    contextWindow: 256_000,
    maxInputTokens: 256_000,
    maxOutputTokens: 32_000,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: aimlapi/cohere/command-a
  'command-a': {
    contextWindow: 256_000,
    maxInputTokens: 256_000,
    maxOutputTokens: 256_000,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: cohere/command-a-vision-07-2025
  'command-a-vision': {
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 8_000,
    reasoningEfforts: [],
    inputModalities: ['text', 'image'],
  },
  // models.dev: perplexity/sonar
  'sonar': {
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 4_096,
    reasoningEfforts: [],
    inputModalities: ['text'],
  },
  // models.dev: perplexity/sonar-pro
  'sonar-pro': {
    contextWindow: 200_000,
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    reasoningEfforts: [],
    inputModalities: ['text', 'image'],
  },
  // models.dev: perplexity/sonar-reasoning-pro
  'sonar-reasoning-pro': {
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 4_096,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text', 'image'],
  },
  // models.dev: perplexity/sonar-deep-research
  'sonar-deep-research': {
    contextWindow: 128_000,
    maxInputTokens: 128_000,
    maxOutputTokens: 32_768,
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text'],
  },
};
