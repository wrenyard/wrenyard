import { defineProvider, anthropic, REASONING_FULL } from '../base/model-defaults.ts';

export const definition = defineProvider({
  modelProtocols: ['anthropic_messages'],
  id: 'anthropic', displayName: 'Anthropic', credentialResolver: 'managed',
  defaultModel: 'claude-sonnet-5-5', quotaProvider: 'anthropic',
  models: [
    { canonical: 'claude-opus-5-5', overrides: { family: 'claude', claudeTier: 'opus', supports1MContext: true, reasoningEfforts: REASONING_FULL.filter(e => e !== 'none'), supportsFast: true } },
    { canonical: 'claude-sonnet-5-5', overrides: { family: 'claude', claudeTier: 'sonnet', supports1MContext: true, reasoningEfforts: REASONING_FULL.filter(e => e !== 'none') } },
    { canonical: 'claude-haiku-5-5', overrides: { family: 'claude', claudeTier: 'haiku', supports1MContext: true, reasoningEfforts: REASONING_FULL.filter(e => e !== 'none') } },
  ],
  // Messages `speed` is the only Fast surface: fast means on, standard means
  // explicitly off. Reasoning effort and the thinking configuration stay
  // untouched.
  fastMapping: {
    request: (_modelId, fast, protocol) => protocol === 'anthropic_messages'
      ? { speed: fast ? 'fast' : 'standard' }
      : {},
  },
  reasoningEffortMappings: {
    'claude-opus-5-5': { claude: Object.fromEntries(REASONING_FULL.filter(e => e !== 'none').map(e => [e,{effort:e}])) },
    'claude-sonnet-5-5': { claude: Object.fromEntries(REASONING_FULL.filter(e => e !== 'none').map(e => [e,{effort:e}])) },
    'claude-haiku-5-5': { claude: Object.fromEntries(REASONING_FULL.filter(e => e !== 'none').map(e => [e,{effort:e}])) },
  },
  protocols: [anthropic('https://api.anthropic.com/v1/messages', 'x-api-key')],
  convertReasoningEffort: (_modelId, effort, protocol) => {
    if (protocol !== 'anthropic_messages') throw new Error('Anthropic only supports the Messages protocol');
    if (effort === 'none') throw new Error('This Claude route cannot disable thinking');
    return { thinking: { type: 'adaptive' }, output_config: { effort } };
  },
  description: 'Anthropic 官方开放平台 API，与 Claude Code 登录态分开配置。',
  setupHint: '输入 Anthropic API Key；Key 仅写入本机 Wrenyard runtime。',
});
