import { defineProvider, THINKING_FULL, effortLadder } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'chatgpt', displayName: 'ChatGPT', credentialResolver: 'codex',
  nativeClients: ['codex'], defaultModel: 'gpt-6.1-sol', quotaProvider: 'chatgpt',
  models: [
    { canonical: 'gpt-6-astra', overrides: { contextWindow: 1_050_000 } },
    'gpt-6.1-sol',
    'gpt-6-luna',
  ],
  modelAliases: { 'codex-astra': 'gpt-6-astra' },
  // The subscription Responses surface of the ChatGPT backend. Codex-native
  // clients keep their existing native transport; this entry only lets the
  // Model Gateway forward the exact openai_responses protocol.
  protocols: [
    {
      protocol: 'openai_responses',
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      authScheme: 'bearer',
    },
  ],
  // Native Codex wire identity effort: each declared level is sent as the exact
  // effort token; the public canonical model id is retained.
  thinkingMappings: {
    'gpt-6-astra': { codex: effortLadder(THINKING_FULL) },
    'gpt-6.1-sol': { codex: effortLadder(THINKING_FULL) },
    'gpt-6-luna': { codex: effortLadder(THINKING_FULL) },
  },
  description: 'ChatGPT 编程模型使用账号适用的 5h、7d 额度池。',
  setupHint: '请使用 Codex CLI 完成登录，返回啾啾工坊后刷新状态。',
});
