import { defineProvider, CANONICAL_MODELS, model, THINKING_FULL } from '../base/model-defaults.ts';
import type { ThinkingLevel } from '../base/index.ts';

// Cursor GPT-5.6 exposes thinking by model id substitution; the target carries
// the 272k context, the exact reasoning level and fast=false, so no separate
// effort argument is ever emitted.
const cursorGptThinkingMappings = (modelId: string): Readonly<Record<ThinkingLevel, { model: string }>> =>
  Object.fromEntries(THINKING_FULL.map((level) => [level, { model: `${modelId}[context=272k,reasoning=${level},fast=false]` }])) as Readonly<Record<ThinkingLevel, { model: string }>>;

export const definition = defineProvider({
  id: 'cursor', displayName: 'Cursor', credentialResolver: 'cursor', nativeClients: ['cursor'],
  defaultModel: 'composer-2.5', quotaProvider: 'cursor', useClientBinary: true,
  models: [
    { ...model('composer-2.5', 200_000), pricing: [0.2, 0.5, 2.5] },
    model('grok-4.6', 256_000, undefined, undefined, ['high']),
    model('kimi-k3', 1_048_576, undefined, CANONICAL_MODELS['kimi-k3']),
    { ...model('claude-opus-5', 300_000, undefined, CANONICAL_MODELS['claude-opus-5']), capabilities: ['text', 'image'], pricing: [0.5, 5, 25] },
    { ...model('gpt-5.6-luna', 272_000, undefined, CANONICAL_MODELS['gpt-5.6-luna'], THINKING_FULL), capabilities: ['text', 'image'], pricing: [0.02, 0.2, 1.2] },
    { ...model('gpt-5.6-terra', 272_000, undefined, CANONICAL_MODELS['gpt-5.6-terra'], THINKING_FULL), capabilities: ['text', 'image'], pricing: [0.2, 2, 12] },
    { ...model('gpt-5.6-sol', 272_000, undefined, CANONICAL_MODELS['gpt-5.6-sol'], THINKING_FULL), capabilities: ['text', 'image'], pricing: [0.4, 4, 20] },
    { ...model('claude-sonnet-5', 300_000), capabilities: ['text', 'image'], pricing: [0.2, 2, 10] },
    model('muse-spark-1.3', 300_000),
    model('gemini-3.8-flash', 1_000_000),
    { ...model('claude-fable-5', 300_000), capabilities: ['text', 'image'], pricing: [1, 10, 50] },
    model('claude-fable-5-1', 300_000),
  ],
  modelAliases: { 'cursor-grok-4.6-high': 'grok-4.6' },
  // Cursor GPT-5.6 materializes a level as a suffixed model id plus an inline
  // [context=272k,reasoning=LEVEL,fast=false] target; effort is never an
  // argument. Cursor Grok is only confirmed at high, as the public grok-4.6
  // id mapping to the exact cursor-grok-4.6-high model.
  thinkingMappings: {
    'gpt-5.6-sol': { cursor: cursorGptThinkingMappings('gpt-5.6-sol') },
    'gpt-5.6-terra': { cursor: cursorGptThinkingMappings('gpt-5.6-terra') },
    'gpt-5.6-luna': { cursor: cursorGptThinkingMappings('gpt-5.6-luna') },
    'grok-4.6': { cursor: { high: { model: 'cursor-grok-4.6-high' } } },
  },
  description: 'Cursor 提供 Composer、Grok 以及 GPT、Claude、Muse 与 Gemini 等多厂商模型服务。',
  setupHint: '请在 Cursor Desktop 中完成登录，返回啾啾工坊后刷新状态。',
});
