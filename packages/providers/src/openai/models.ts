import { defineProvider, CANONICAL_MODELS, model, openAI, THINKING_FULL, effortLadder } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'openai', displayName: 'OpenAI', credentialResolver: 'forge-managed', defaultModel: 'gpt-5.6-sol',
  models: [model('gpt-5.6-sol', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-sol'], THINKING_FULL), model('gpt-5.6-terra', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-terra'], THINKING_FULL), model('gpt-5.6-luna', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-luna'], THINKING_FULL)],
  thinkingMappings: Object.fromEntries(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map(id => [id, {
    codex: effortLadder(THINKING_FULL), codebuddy: effortLadder(THINKING_FULL), grok: effortLadder(THINKING_FULL),
  }])),
  protocols: [
    openAI('https://api.openai.com/v1/chat/completions'),
    { protocol: 'openai_responses', endpoint: 'https://api.openai.com/v1/responses', authScheme: 'bearer' },
  ],
  description: 'OpenAI 官方开放平台 API，与 Codex 登录态分开配置。',
  setupHint: '输入 OpenAI API Key；Key 仅写入本机 Wrenyard runtime。',
});
