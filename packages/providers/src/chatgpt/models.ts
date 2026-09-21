import { defineProvider, CANONICAL_MODELS, model, THINKING_FULL, THINKING_UP_TO_XHIGH, effortLadder } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'chatgpt', displayName: 'ChatGPT', credentialResolver: 'codex',
  nativeClients: ['codex'], defaultModel: 'gpt-5.6-sol', quotaProvider: 'chatgpt',
  models: [
    model('gpt-5.6-sol', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-sol'], THINKING_FULL),
    model('gpt-5.6-terra', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-terra'], THINKING_FULL),
    model('gpt-5.6-luna', 1_050_000, 131_072, CANONICAL_MODELS['gpt-5.6-luna'], THINKING_FULL),
    model('gpt-6-astra', 1_050_000, 128_000, undefined, THINKING_FULL),
    { ...model('gpt-5.5', undefined, undefined, undefined, THINKING_UP_TO_XHIGH) },
    { ...model('gpt-5.4', undefined, undefined, undefined, THINKING_UP_TO_XHIGH) },
  ],
  modelAliases: { 'codex-astra': 'gpt-6-astra' },
  // Native Codex wire identity effort: each declared level is sent as the exact
  // effort token; the public canonical model id is retained.
  thinkingMappings: {
    'gpt-5.6-sol': { codex: effortLadder(THINKING_FULL) },
    'gpt-5.6-terra': { codex: effortLadder(THINKING_FULL) },
    'gpt-5.6-luna': { codex: effortLadder(THINKING_FULL) },
    'gpt-6-astra': { codex: effortLadder(THINKING_FULL) },
    'gpt-5.5': { codex: effortLadder(THINKING_UP_TO_XHIGH) },
    'gpt-5.4': { codex: effortLadder(THINKING_UP_TO_XHIGH) },
  },
  description: 'ChatGPT 编程模型使用账号适用的 5h、7d 额度池。',
  setupHint: '请使用 Codex CLI 完成登录，返回啾啾工坊后刷新状态。',
});
