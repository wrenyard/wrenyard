import { defineProvider, model, openAI, anthropic, THINKING_LOW_HIGH_MAX, effortLadder } from '../base/model-defaults.ts';

export const definition = defineProvider({
  id: 'kimi-coding', displayName: 'Kimi Coding', credentialResolver: 'managed',
  defaultModel: 'k3', quotaProvider: 'kimi-coding',
  models: [
    model('k3', 1_048_576, 32_768, 'kimi-k3', THINKING_LOW_HIGH_MAX),
    // K2.8 Preview context is 1M; no official max-output or reference token
    // price is published, so neither is registered. `kimi-for-coding` is the
    // exact official wire id clients send for this canonical model.
    model('kimi-k2.8', 1_048_576, undefined, 'kimi-k2.8', THINKING_LOW_HIGH_MAX),
  ],
  modelAliases: { 'kimi-for-coding': 'kimi-k2.8' },
  protocols: [
    openAI('https://api.kimi.com/coding/v1/chat/completions'),
    anthropic('https://api.kimi.com/coding/v1/messages'),
  ],
  // Gateway clients may materialize K3 thinking once their native syntax
  // supports it; the exact wire alias is the level itself. K2.8 Preview
  // exposes the same low/high/max ladder to the same clients.
  thinkingMappings: {
    k3: {
      codex: effortLadder(THINKING_LOW_HIGH_MAX),
      claude: effortLadder(THINKING_LOW_HIGH_MAX),
      codebuddy: effortLadder(THINKING_LOW_HIGH_MAX),
      grok: effortLadder(THINKING_LOW_HIGH_MAX),
    },
    'kimi-k2.8': {
      codex: effortLadder(THINKING_LOW_HIGH_MAX),
      claude: effortLadder(THINKING_LOW_HIGH_MAX),
      codebuddy: effortLadder(THINKING_LOW_HIGH_MAX),
      grok: effortLadder(THINKING_LOW_HIGH_MAX),
    },
  },
  description: 'Moonshot Kimi K3 与 Kimi K2.8 Preview 编程模型与订阅额度。',
  setupHint: '输入 Kimi Coding API Key；Key 仅写入本机 Wrenyard runtime。',
});
