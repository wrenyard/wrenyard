import { defineProvider, THINKING_FULL, effortLadder } from '../base/model-defaults.ts';

// GPT-6 reasoning with tool calls requires Responses; Chat Completions only
// supports tool calls with reasoning disabled.
export const definition = defineProvider({
  id: 'openai', displayName: 'OpenAI', credentialResolver: 'managed', defaultModel: 'gpt-6-sol',
  models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
  thinkingMappings: {
    'gpt-6-astra': { codex: effortLadder(THINKING_FULL) },
    'gpt-6-sol': { codex: effortLadder(THINKING_FULL) },
    'gpt-6-luna': { codex: effortLadder(THINKING_FULL) },
  },
  protocols: [
    { protocol: 'openai_responses', endpoint: 'https://api.openai.com/v1/responses', authScheme: 'bearer' },
  ],
  description: 'OpenAI 官方开放平台 API，与 Codex 登录态分开配置。',
  setupHint: '输入 OpenAI API Key；Key 仅写入本机 Wrenyard runtime。',
});
