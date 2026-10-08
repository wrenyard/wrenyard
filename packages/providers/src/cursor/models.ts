import { defineProvider, model, REASONING_UP_TO_XHIGH, REASONING_FULL, REASONING_LOW_HIGH_MAX } from '../base/model-defaults.ts';
import type { ReasoningEffort } from '../base/index.ts';

// Exact native model names from PC3 cursor-agent --list-models (2026-10-08).
const suffixMappings = (id: string, levels: readonly ReasoningEffort[]) =>
  Object.fromEntries(levels.map(effort => [effort, { model: `${id}-${effort}` }]));
const FIVE_LEVELS = REASONING_FULL.filter(effort => effort !== 'none');

export const definition = defineProvider({
  id: 'cursor', displayName: 'Cursor', credentialResolver: 'cursor', nativeClients: ['cursor'],
  defaultModel: 'composer-2.5', quotaProvider: 'cursor', useClientBinary: true,
  models: [
    { ...model('composer-2.5', 200_000), pricing: [0.2, 0.5, 2.5], reasoningEfforts: ['high'] },
    model('grok-4.6', 256_000, undefined, undefined, REASONING_UP_TO_XHIGH),
    model('grok-4.7', 256_000, undefined, 'grok-4.7', REASONING_UP_TO_XHIGH),
    model('kimi-k3', 1_048_576, undefined, 'kimi-k3', REASONING_LOW_HIGH_MAX),
    { canonical: 'claude-opus-5-5', overrides: { contextWindow: 300_000, supports1MContext: true, reasoningEfforts: FIVE_LEVELS } },
    { ...model('gpt-5.6-luna', 272_000, undefined, 'gpt-5.6-luna', REASONING_FULL), capabilities: ['text', 'image'], pricing: [0.02, 0.2, 1.2] },
    { ...model('gpt-5.6-sol', 272_000, undefined, 'gpt-5.6-sol', REASONING_FULL), capabilities: ['text', 'image'], pricing: [0.4, 4, 20] },
    { canonical: 'claude-sonnet-5-5', overrides: { contextWindow: 200_000, supports1MContext: true, reasoningEfforts: FIVE_LEVELS } },
    model('muse-spark-1.3', 300_000, undefined, undefined, FIVE_LEVELS),
    model('gemini-3.8-flash', 1_000_000, undefined, undefined, ['low', 'medium', 'high']),
    model('claude-fable-5-1', 300_000, undefined, undefined, FIVE_LEVELS),
  ],
  modelAliases: {
    'cursor-grok-4.6-high': 'grok-4.6',
    'grok-4.7-high': 'grok-4.7',
  },
  reasoningEffortMappings: {
    'gpt-5.6-sol': { cursor: suffixMappings('gpt-5.6-sol', REASONING_FULL) },
    'gpt-5.6-luna': { cursor: suffixMappings('gpt-5.6-luna', REASONING_FULL) },
    'composer-2.5': { cursor: { high: { model: 'composer-2.5' } } },
    'kimi-k3': { cursor: suffixMappings('kimi-k3', REASONING_LOW_HIGH_MAX) },
    'claude-opus-5-5': { cursor: suffixMappings('claude-opus-5-5', FIVE_LEVELS) },
    'claude-sonnet-5-5': { cursor: suffixMappings('claude-sonnet-5-5', FIVE_LEVELS) },
    'muse-spark-1.3': { cursor: suffixMappings('muse-spark-1.3', FIVE_LEVELS) },
    'gemini-3.8-flash': { cursor: suffixMappings('gemini-3.8-flash', ['low', 'medium', 'high']) },
    'claude-fable-5-1': { cursor: suffixMappings('claude-fable-5-1-thinking', FIVE_LEVELS) },
    'grok-4.6': { cursor: suffixMappings('cursor-grok-4.6', REASONING_UP_TO_XHIGH) },
    'grok-4.7': { cursor: suffixMappings('grok-4.7', REASONING_UP_TO_XHIGH) },
  },
  convertReasoningEffort: () => { throw new Error('Cursor only supports native model substitutions'); },
  description: 'Cursor 提供 Composer、Grok 以及 GPT、Claude、Muse 与 Gemini 等多厂商模型服务。',
  setupHint: '请在 Cursor Desktop 中完成登录，返回啾啾工坊后刷新状态。',
});
