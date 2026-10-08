import { defineProvider, model, anthropic, REASONING_FULL } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'anthropic', displayName: 'Anthropic', credentialResolver: 'managed',
  defaultModel: 'claude-sonnet-5-5', quotaProvider: 'anthropic',
  models: [
    { canonical: 'claude-opus-5-5', overrides: { family: 'claude', claudeTier: 'opus', supports1MContext: true, reasoningEfforts: REASONING_FULL.filter(e => e !== 'none') } },
    { canonical: 'claude-sonnet-5-5', overrides: { family: 'claude', claudeTier: 'sonnet', supports1MContext: true, reasoningEfforts: REASONING_FULL.filter(e => e !== 'none') } },
    { ...model('claude-haiku-4-5-20251001', 200_000, 64_000, 'claude-haiku-4-5', ['none', 'medium']), family: 'claude', claudeTier: 'haiku' },
  ],
  reasoningEffortMappings: {
    'claude-opus-5-5': { claude: Object.fromEntries(REASONING_FULL.filter(e => e !== 'none').map(e => [e,{effort:e}])) },
    'claude-sonnet-5-5': { claude: Object.fromEntries(REASONING_FULL.filter(e => e !== 'none').map(e => [e,{effort:e}])) },
    'claude-haiku-4-5-20251001': { claude: { none:{environment:{MAX_THINKING_TOKENS:'0'}}, medium:{environment:{MAX_THINKING_TOKENS:'8192'}} } },
  },
  protocols: [anthropic('https://api.anthropic.com/v1/messages', 'x-api-key')],
  convertReasoningEffort: (modelId, effort, protocol) => {
    if (protocol !== 'anthropic_messages') throw new Error('Anthropic only supports the Messages protocol');
    if (modelId === 'claude-haiku-4-5-20251001') return effort === 'none' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled', budget_tokens: 8192 } };
    if (effort === 'none') throw new Error('This Claude route cannot disable thinking');
    return { thinking: { type: 'adaptive' }, output_config: { effort } };
  },
  description: 'Anthropic 官方开放平台 API，与 Claude Code 登录态分开配置。',
  setupHint: '输入 Anthropic API Key；Key 仅写入本机 Wrenyard runtime。',
});
