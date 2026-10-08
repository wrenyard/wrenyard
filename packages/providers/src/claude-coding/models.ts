import { defineProvider, REASONING_FULL } from '../base/model-defaults.ts';

// Native effort and extended-thinking budgets are materialized per launch.
export const definition = defineProvider({
  id: 'claude-coding', displayName: 'Claude', credentialResolver: 'claude',
  nativeClients: ['claude'],
  models: [
    { canonical: 'claude-opus-5-5', overrides: { reasoningEfforts: REASONING_FULL.filter(e => e !== 'none') } },
    { canonical: 'claude-sonnet-5-5', overrides: { reasoningEfforts: REASONING_FULL.filter(e => e !== 'none') } },
    { canonical: 'claude-haiku-4-5', overrides: { reasoningEfforts: ['none', 'medium'] } },
  ],
  reasoningEffortMappings: {
    'claude-opus-5-5': { claude: Object.fromEntries(REASONING_FULL.filter(e => e !== 'none').map(e => [e, {effort:e}])) },
    'claude-sonnet-5-5': { claude: Object.fromEntries(REASONING_FULL.filter(e => e !== 'none').map(e => [e, {effort:e}])) },
    'claude-haiku-4-5': { claude: { none: {environment:{MAX_THINKING_TOKENS:'0'}}, medium:{environment:{MAX_THINKING_TOKENS:'8192'}} } },
  },
  quotaProvider: 'claude-coding', useClientBinary: true,
  convertReasoningEffort: () => { throw new Error('Claude Coding only supports native client effort settings'); },
  description: 'Claude Code 与 Anthropic 模型服务。',
  setupHint: '请使用 Claude Code 完成登录，返回啾啾工坊后刷新状态。',
});
